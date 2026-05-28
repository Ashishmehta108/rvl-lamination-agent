import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { config } from "../config.js";
import {
  bedrockConverse,
  bedrockToolsFromDeclarations,
  extractText as extractBedrockText,
  extractToolUses,
  toBedrockMessages
} from "./bedrock.js";
import { buildSystemPrompt } from "./prompts.js";
import { runTool, withTimeout } from "./executor.js";
import { generateChartsFromHistory } from "./charts.js";
import { ALL_TOOL_DECLARATIONS } from "./index.js";
import { MAX_TOOL_CALLS, LLM_TIMEOUT_MS } from "./constants.js";
import type {
  StoredChatMessage,
  AgentToolStep,
  AgentPlan,
  QueryClass,
  AgentResult
} from "./types.js";

export async function runBedrockPipeline(args: {
  userMessage: string;
  history: StoredChatMessage[];
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
  plan: AgentPlan;
  queryClass: QueryClass;
}): Promise<Omit<AgentResult, "trace">> {
  // We need to import or type FastifyBaseLogger, so let's import it at the top
  const toolsUsed: string[] = [];
  const toolSteps: AgentToolStep[] = [];
  const cache = new Map<string, unknown>();
  const messages = toBedrockMessages(args.history, args.userMessage);
  const tools = bedrockToolsFromDeclarations(ALL_TOOL_DECLARATIONS);
  let totalCalls = 0;

  console.log(`\x1b[35m[Agent Pipeline]\x1b[0m Starting Bedrock Reasoning Pipeline with provider configuration:`, config.aiProvider);

  for (let round = 0; round < 8; round++) {
    // Round 0 with requiresTools=true: force at least one tool call using toolChoice: any.
    // This prevents Claude from returning stopReason: end_turn with empty content
    // instead of actually calling tools (a known Bedrock silent-failure pattern).
    const toolChoice = (round === 0 && args.plan.requiresTools)
      ? { any: {} }
      : { auto: {} };

    console.log(`\x1b[35m[Agent Pipeline] [Round ${round}]\x1b[0m Querying model: ${config.bedrockModelId}. ToolChoice:`, toolChoice);
    const roundStart = Date.now();
    
    const response = await withTimeout(
      bedrockConverse({
        systemPrompt: buildSystemPrompt(args.plan, args.queryClass, args.userMessage),
        messages,
        tools,
        toolChoice,
        modelId: config.bedrockModelId,
        temperature: 0.2,
        timeoutMs: LLM_TIMEOUT_MS
      }),
      LLM_TIMEOUT_MS + 2000,
      `bedrock_round_${round}`
    );

    const roundDuration = Date.now() - roundStart;
    const stopReason = response.stopReason;
    const message = response.output?.message;
    const content = message?.content ?? [];
    const toolUses = extractToolUses(content);
    const textReply = extractBedrockText(content);

    args.logger.debug(
      { round, stopReason, toolUses: toolUses.length, hasText: !!textReply, contentBlocks: content.length, sessionId: args.sessionId },
      "bedrock_round"
    );
    console.log(`\x1b[35m[Agent Pipeline] [Round ${round}]\x1b[0m Model responded in ${roundDuration}ms. StopReason: "${stopReason}" | ContentBlocks: ${content.length} | ToolUses: ${toolUses.length} | TextReplyLength: ${textReply ? textReply.length : 0}`);

    // Guard: empty or error response
    // Happens when Bedrock throttles, hits max_tokens, or the model returns nothing.
    if (!content.length || (!toolUses.length && !textReply)) {
      args.logger.warn(
        { round, stopReason, sessionId: args.sessionId, modelId: config.bedrockModelId },
        "bedrock_empty_content"
      );
      console.warn(`\x1b[33m[Agent Pipeline] [Round ${round}]\x1b[0m Empty or invalid content returned from model.`);

      // Round 0, no tools executed yet: retry once as plain text (no toolConfig)
      // to guarantee at least a knowledge-based answer from the system prompt.
      if (round === 0 && totalCalls === 0) {
        args.logger.warn({ sessionId: args.sessionId }, "bedrock_round0_retrying_text_only");
        console.warn(`\x1b[33m[Agent Pipeline] [Round ${round}]\x1b[0m Round 0, no tool calls yet. Retrying text-only fallback...`);
        try {
          const fallbackResp = await withTimeout(
            bedrockConverse({
              systemPrompt: buildSystemPrompt(args.plan, args.queryClass, args.userMessage),
              messages,
              // intentionally omit tools to force a text answer
              modelId: config.bedrockModelId,
              temperature: 0.3,
              timeoutMs: LLM_TIMEOUT_MS
            }),
            LLM_TIMEOUT_MS + 2000,
            "bedrock_text_fallback"
          );
          const fallbackText = extractBedrockText(fallbackResp.output?.message?.content);
          if (fallbackText) {
            console.log(`\x1b[32m[Agent Pipeline] [Round ${round}]\x1b[0m Successfully recovered via text-only fallback.`);
            return {
              reply: `\u26a0 Tools unavailable (stopReason: ${stopReason ?? "UNKNOWN"}). Answer based on system context:\n\n${fallbackText}`,
              toolsUsed,
              toolSteps,
              tokenCount: fallbackResp.usage
                ? (fallbackResp.usage.inputTokens ?? 0) + (fallbackResp.usage.outputTokens ?? 0)
                : undefined
            };
          }
        } catch (retryErr) {
          args.logger.error({ err: String(retryErr), sessionId: args.sessionId }, "bedrock_text_fallback_failed");
          console.error(`\x1b[31m[Agent Pipeline] [Round ${round}]\x1b[0m Text-only fallback retry failed: ${retryErr}`);
        }
      }

      // All retries exhausted
      return {
        reply: [
          `Model returned no content (stopReason: ${stopReason ?? "UNKNOWN"}).`,
          stopReason === "max_tokens"
            ? "The request context was too long. Try a more specific or shorter query."
            : stopReason === "end_turn"
              ? "The model finished without producing output. Try rephrasing your query or splitting it into smaller questions."
              : "This may be a transient Bedrock issue. Please retry in a few seconds."
        ].join(" "),
        toolsUsed,
        toolSteps,
        tokenCount: response.usage
          ? (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0)
          : undefined
      };
    }

    // FINALIZE: model returned text with no tool calls
    if (!toolUses.length) {
      console.log(`\x1b[32m[Agent Pipeline] [Round ${round}] [FINALIZE]\x1b[0m Reasoning pipeline complete. Final reply generated: "${textReply.slice(0, 100).replace(/\n/g, ' ')}${textReply.length > 100 ? '...' : ''}"`);
      return {
        reply: textReply,
        toolsUsed,
        toolSteps,
        tokenCount: response.usage
          ? (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0)
          : undefined
      };
    }

    // Guard: hard cap
    if (totalCalls + toolUses.length > MAX_TOOL_CALLS) {
      args.logger.warn({ totalCalls, requested: toolUses.length, sessionId: args.sessionId }, "agent_tool_cap_reached");
      console.warn(`\x1b[31m[Agent Pipeline] [Round ${round}]\x1b[0m Tool call limit cap reached (${MAX_TOOL_CALLS}). Terminating reasoning early.`);
      return {
        reply: extractBedrockText(content) || "Analysis stopped: maximum tool call limit reached.",
        toolsUsed,
        toolSteps
      };
    }

    if (message) messages.push(message);

    console.log(`\x1b[32m[Agent Pipeline] [Round ${round}]\x1b[0m Executing ${toolUses.length} tool call(s) sequentially...`);
    const toolResultContent: ContentBlock[] = await Promise.all(
      toolUses.map(async (toolUse) => {
        const name = toolUse.name ?? "unknown_tool";
        const toolArgs =
          toolUse.input && typeof toolUse.input === "object"
            ? (toolUse.input as Record<string, unknown>)
            : {};

        const r = await runTool({
          name,
          args: toolArgs,
          machineId: args.machineId,
          sessionId: args.sessionId,
          logger: args.logger,
          cache,
          toolSteps,
          toolsUsed,
          queryClass: args.queryClass,
          userMessage: args.userMessage
        });

        const isError = "error" in r.functionResponse.response;
        return {
          toolResult: {
            toolUseId: toolUse.toolUseId ?? "",
            status: isError ? ("error" as const) : ("success" as const),
            content: [{ json: r.functionResponse.response }]
          }
        } as ContentBlock;
      })
    );
    totalCalls += toolUses.length;

    messages.push({ role: "user", content: toolResultContent });
  }

  console.error(`\x1b[31m[Agent Pipeline]\x1b[0m Maximum reasoning rounds reached (8). Returning early.`);
  return {
    reply: "Analysis could not be completed: maximum reasoning rounds reached.",
    toolsUsed,
    toolSteps,
    charts: generateChartsFromHistory(toolSteps)
  };
}

import type { FastifyBaseLogger } from "fastify";
