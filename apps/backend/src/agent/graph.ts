/**
 * agent/graph.ts
 * ─────────────────────────────────────────────────────────────────
 * LangGraph state machine for the RVL Lamination chat pipeline.
 *
 * Graph topology (deterministic — no agent loop, no self-routing):
 *
 *   ingressNode
 *     ↓ (blocked) → responseNode
 *     ↓ (safe)
 *   routerNode
 *     ↓
 *   contextNode
 *     ↓ (requiresLlm=false) → responseNode
 *     ↓ (requiresLlm=true)
 *   llmNode
 *     ↓
 *   groundingNode
 *     ↓
 *   responseNode
 *     ↓
 *   END
 *
 * Every node is a pure async function that reads from AgentState
 * and returns a Partial<AgentState> to merge. No node mutates
 * shared state outside its return value.
 * ─────────────────────────────────────────────────────────────────
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { randomUUID } from "crypto";

import type { AgentState, ChatRequest, LiveContext, ToolBlock } from "./types.js";
import { makeInitialState } from "./types.js";
import { buildChatTools } from "./tools.js";
import { runPlannerChain } from "./plannerChain.js";
import { runLlmChain } from "./llmChain.js";

import {
  normalizeInput,
  detectRisk,
  detectIntent,
  detectMissingContext,
  selectHandler,
  buildContextPacket,
  handleGreeting,
  handleEscalation,
  handleUnsafeInput,
  handleOutOfScope,
  handleAmbiguous,
  handleNoContext,
  handleToolFailure,
  assembleFinalResponse,
  validateOutput,
} from "../handlers/chatHandler.js";

import { enforceGroundingGuard } from "../services/groundingGuard.js";
import { applyStyleRewrite } from "../services/styleRewriter.js";
import { buildMemoryWindow } from "../services/memoryPolicy.js";
import { buildChatPromptDescriptor } from "../services/promptRegistry.js";
import { applySmallModelBudget, buildChatMessages } from "../services/tokenBudgeter.js";
import { deriveHealthFromLiveContexts, toolBlocksToLiveContexts } from "../services/llmOrchestrator.js";
import { recordTrace } from "../services/llmTraceStore.js";
import { wantsToolPipeline } from "../services/chatPlanner.js";
import { runToolPlan } from "../services/chatTools.js";
import type { ChatToolCall } from "../services/chatTools.js";
import type { ChatHistoryMessage } from "../services/chatHistoryCache.js";

// ─── LangGraph annotation (reducer: last-write-wins per field) ─────

const AgentAnnotation = Annotation.Root({
  request: Annotation<ChatRequest>(),
  sessionKey: Annotation<string>(),
  cachedHistory: Annotation<ChatHistoryMessage[]>(),
  normalized: Annotation<AgentState["normalized"]>(),
  risk: Annotation<AgentState["risk"]>(),
  intent: Annotation<AgentState["intent"]>(),
  contextAssessment: Annotation<AgentState["contextAssessment"]>(),
  handlerDecision: Annotation<AgentState["handlerDecision"]>(),
  toolCalls: Annotation<ChatToolCall[]>(),
  toolBlocks: Annotation<ToolBlock[]>(),
  liveContexts: Annotation<LiveContext[]>(),
  contextPacket: Annotation<AgentState["contextPacket"]>(),
  health: Annotation<AgentState["health"]>(),
  rawLlmAnswer: Annotation<AgentState["rawLlmAnswer"]>(),
  llmLatencyMs: Annotation<number>(),
  retried: Annotation<boolean>(),
  groundingConfidence: Annotation<AgentState["groundingConfidence"]>(),
  groundingReason: Annotation<AgentState["groundingReason"]>(),
  validationPassed: Annotation<boolean>(),
  fallbackUsed: Annotation<boolean>(),
  fallbackReason: Annotation<AgentState["fallbackReason"]>(),
  styleRewriteApplied: Annotation<boolean>(),
  answer: Annotation<AgentState["answer"]>(),
  traceId: Annotation<string>(),
  startedAt: Annotation<number>(),
  promptId: Annotation<string>(),
  promptVersion: Annotation<string>(),
  budgetTrimmedSources: Annotation<string[]>(),
  ragChunkCount: Annotation<number>(),
  liveContextSources: Annotation<string[]>(),
  estimatedTokens: Annotation<number>(),
});

// ─── Node: ingress ─────────────────────────────────────────────────

async function ingressNode(
  state: typeof AgentAnnotation.State
): Promise<Partial<typeof AgentAnnotation.State>> {
  const normalized = normalizeInput(state.request.message);
  const risk = detectRisk(normalized);

  console.log(
    `[graph:ingress] traceId=${state.traceId} risk=${risk.level} wordCount=${normalized.wordCount}`
  );

  return { normalized, risk };
}

// ─── Conditional edge: after ingress ──────────────────────────────

function afterIngress(state: typeof AgentAnnotation.State): string {
  if (state.risk?.block) return "responseNode"; // skip everything, hard block
  return "routerNode";
}

// ─── Node: router ─────────────────────────────────────────────────

async function routerNode(
  state: typeof AgentAnnotation.State
): Promise<Partial<typeof AgentAnnotation.State>> {
  const { normalized, risk, cachedHistory } = state;
  if (!normalized || !risk) throw new Error("routerNode: normalized/risk missing");

  const previousQuery = [...cachedHistory]
    .reverse()
    .find((m) => m.role === "user")?.content ?? undefined;

  const intent = detectIntent(normalized, previousQuery);

  // Preliminary context assessment with empty live data — used only for structural
  // routing decisions. Real context assessment runs in contextNode after tool fetches.
  const preliminaryCtx = detectMissingContext([], intent);
  const handlerDecision = selectHandler(normalized, risk, intent, preliminaryCtx, []);

  console.log(
    `[graph:router] traceId=${state.traceId} handler=${handlerDecision.handler} requiresLlm=${handlerDecision.requiresLlm}`
  );

  return { intent, contextAssessment: preliminaryCtx, handlerDecision };
}

// ─── Conditional edge: after router ───────────────────────────────

/**
 * Purely static handlers go straight to responseNode — no DB fetch, no LLM.
 * Everything else needs contextNode to fetch live data and re-evaluate.
 */
function afterRouter(state: typeof AgentAnnotation.State): "responseNode" | "contextNode" {
  const h = state.handlerDecision;
  if (!h) return "responseNode";

  // These handlers never need live data or LLM — return deterministic answer immediately
  if (
    h.handler === "greeting" ||
    h.handler === "escalation" ||
    h.handler === "unsafe"
  ) {
    return "responseNode";
  }

  // out_of_scope and ambiguous have deterministic fallbackAnswer — skip context fetch
  if (h.fallbackAnswer !== undefined && !h.requiresLlm) {
    return "responseNode";
  }

  return "contextNode";
}

// ─── Node: context ─────────────────────────────────────────────────

async function contextNode(
  state: typeof AgentAnnotation.State
): Promise<Partial<typeof AgentAnnotation.State>> {
  const { request, intent, normalized, risk, handlerDecision, cachedHistory } = state;
  if (!intent || !normalized || !risk || !handlerDecision) {
    throw new Error("contextNode: missing upstream state");
  }

  let toolCalls: ChatToolCall[] = [];
  let toolBlocks: ToolBlock[] = [];
  let liveContexts: LiveContext[] = [];

  // ── Tool pipeline ──
  const runTools = wantsToolPipeline(request.message, request.tagIds);
  if (runTools) {
    try {
      toolCalls = await runPlannerChain(request.message, request.tagIds);
    } catch (err) {
      console.warn("[graph:context] planner error — empty tool plan", err);
      toolCalls = [];
    }

    if (toolCalls.length > 0) {
      try {
        const result = await runToolPlan(request.machineId, toolCalls);
        toolBlocks = result.blocks;
        liveContexts = toolBlocksToLiveContexts(result.blocks) as LiveContext[];
      } catch (err) {
        console.warn("[graph:context] tool execution error — empty live contexts", err);
        liveContexts = [];
      }
    }
  }

  const health = deriveHealthFromLiveContexts(liveContexts);

  // Re-run detectMissingContext with real live data
  const contextAssessment = detectMissingContext(liveContexts, intent);

  // Re-evaluate handler with real context
  const updatedHandler = selectHandler(normalized, risk, intent, contextAssessment, liveContexts);

  const capturedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const contextPacket = buildContextPacket(
    updatedHandler,
    normalized,
    intent,
    contextAssessment,
    liveContexts,
    request.machineId,
    capturedAt,
    health
  );

  console.log(
    `[graph:context] traceId=${state.traceId} tools=${toolCalls.length} liveCtx=${liveContexts.length} health=${health} handler=${updatedHandler.handler}`
  );

  return {
    toolCalls,
    toolBlocks,
    liveContexts,
    health,
    contextAssessment,
    handlerDecision: updatedHandler,
    contextPacket,
    liveContextSources: liveContexts.map((c) => c.source),
  };
}

// ─── Conditional edge: after context ──────────────────────────────

function afterContext(state: typeof AgentAnnotation.State): string {
  if (!state.handlerDecision?.requiresLlm) return "responseNode";
  return "llmNode";
}

// ─── Node: llm ─────────────────────────────────────────────────────

async function llmNode(
  state: typeof AgentAnnotation.State
): Promise<Partial<typeof AgentAnnotation.State>> {
  const { contextPacket, liveContexts, cachedHistory, request } = state;
  if (!contextPacket) throw new Error("llmNode: contextPacket missing");

  // Build memory window
  const memory = buildMemoryWindow({
    requestMessages: [{ role: "user", content: request.message }],
    cachedMessages: cachedHistory,
  });

  // Build prompt
  const promptDescriptor = buildChatPromptDescriptor(contextPacket, "small-model");

  // Budget
  const budgeted = applySmallModelBudget({
    systemPrompt: promptDescriptor.systemPrompt,
    history: memory.messages,
    liveContexts,
    ragContexts: [],
  });

  const messages = buildChatMessages(budgeted.systemPrompt, budgeted.history);

  console.log(
    `[graph:llm] traceId=${state.traceId} estimatedTokens=${budgeted.estimatedTokens} trimmed=${budgeted.budgetReport.trimmedSources.join(",") || "none"}`
  );

  const result = await runLlmChain(messages);

  return {
    rawLlmAnswer: result.answer,
    llmLatencyMs: result.llmLatencyMs,
    retried: result.retried,
    promptId: promptDescriptor.id,
    promptVersion: promptDescriptor.version,
    estimatedTokens: budgeted.estimatedTokens,
    budgetTrimmedSources: budgeted.budgetReport.trimmedSources,
  };
}

// ─── Node: grounding ───────────────────────────────────────────────

async function groundingNode(
  state: typeof AgentAnnotation.State
): Promise<Partial<typeof AgentAnnotation.State>> {
  const { rawLlmAnswer, contextPacket, liveContexts } = state;
  if (!rawLlmAnswer || !contextPacket) throw new Error("groundingNode: missing llm output or packet");

  const guardResult = enforceGroundingGuard(rawLlmAnswer, contextPacket, liveContexts);

  console.log(
    `[graph:grounding] traceId=${state.traceId} confidence=${guardResult.confidence} reason=${guardResult.reason}`
  );

  if (guardResult.confidence === "insufficient" || guardResult.confidence === "contradicted") {
    return {
      answer: contextPacket.fallback,
      groundingConfidence: guardResult.confidence,
      groundingReason: guardResult.reason,
      fallbackUsed: true,
      fallbackReason: `grounding_guard:${guardResult.reason}`,
      validationPassed: false,
    };
  }

  // Run output validator
  const validation = validateOutput(guardResult.cleaned, contextPacket, liveContexts);
  if (!validation.valid) {
    console.warn(
      `[graph:grounding] validateOutput failed (${validation.reason}) — using fallback`
    );
    return {
      answer: contextPacket.fallback,
      groundingConfidence: guardResult.confidence,
      groundingReason: validation.reason,
      fallbackUsed: true,
      fallbackReason: `validation:${validation.reason}`,
      validationPassed: false,
    };
  }

  return {
    rawLlmAnswer: validation.cleaned,
    groundingConfidence: guardResult.confidence,
    groundingReason: guardResult.reason,
    validationPassed: true,
    fallbackUsed: false,
    fallbackReason: null,
  };
}

// ─── Node: response ────────────────────────────────────────────────

async function responseNode(
  state: typeof AgentAnnotation.State
): Promise<Partial<typeof AgentAnnotation.State>> {
  const { handlerDecision, contextPacket, rawLlmAnswer, risk, fallbackUsed } = state;

  let answer: string;

  // ── Deterministic handlers (no LLM) ──
  if (!handlerDecision || risk?.block) {
    answer = handleUnsafeInput();
  } else if (handlerDecision.handler === "greeting") {
    answer = handleGreeting();
  } else if (handlerDecision.handler === "escalation") {
    answer = handleEscalation();
  } else if (handlerDecision.handler === "out_of_scope") {
    answer = handlerDecision.fallbackAnswer ?? handleOutOfScope();
  } else if (handlerDecision.handler === "ambiguous") {
    answer = handleAmbiguous();
  } else if (handlerDecision.handler === "no_context") {
    answer = handleNoContext();
  } else if (handlerDecision.handler === "tool_failure") {
    answer = handleToolFailure();
  } else if (fallbackUsed && contextPacket) {
    // Grounding guard triggered fallback — assemble with deterministic blocks still
    const narrative = contextPacket.fallback;
    answer = assembleFinalResponse(narrative, contextPacket, handlerDecision);
  } else if (rawLlmAnswer && contextPacket) {
    // Normal path — apply style rewrite then assemble
    const rewrite = applyStyleRewrite({
      approvedFactPacket: contextPacket.brief,
      rawLlmAnswer,
      handler: handlerDecision.handler,
    });

    const narrative = rewrite.rewritten;
    answer = assembleFinalResponse(narrative, contextPacket, handlerDecision);

    console.log(
      `[graph:response] traceId=${state.traceId} styleChanged=${rewrite.changed} reason=${rewrite.reason}`
    );

    return {
      answer,
      styleRewriteApplied: rewrite.changed,
    };
  } else {
    // Last resort — handler fallback or static
    answer = contextPacket?.fallback ?? "I don't have enough context to answer right now.";
  }

  return { answer, styleRewriteApplied: false };
}

// ─── Node: trace ───────────────────────────────────────────────────

async function traceNode(
  state: typeof AgentAnnotation.State
): Promise<Partial<typeof AgentAnnotation.State>> {
  const totalLatencyMs = Date.now() - state.startedAt;

  recordTrace({
    traceId: state.traceId,
    sessionKey: state.sessionKey,
    machineId: state.request.machineId,
    timestamp: state.startedAt,
    promptId: state.promptId,
    promptVersion: state.promptVersion,
    modelUsed: state.handlerDecision?.requiresLlm ? "chat" : "none",
    handler: state.handlerDecision?.handler ?? "unknown" as any,
    estimatedTokens: state.estimatedTokens,
    budgetTrimmedSources: state.budgetTrimmedSources,
    liveContextSources: state.liveContextSources,
    ragChunkCount: state.ragChunkCount,
    groundingConfidence: state.groundingConfidence ?? "grounded",
    validationPassed: state.validationPassed,
    fallbackUsed: state.fallbackUsed,
    fallbackReason: state.fallbackReason,
    styleRewriteApplied: state.styleRewriteApplied,
    llmLatencyMs: state.llmLatencyMs,
    totalLatencyMs,
    retried: state.retried,
    answerPreview: (state.answer ?? "").slice(0, 200),
  });

  console.log(
    `[graph:trace] traceId=${state.traceId} handler=${state.handlerDecision?.handler} totalMs=${totalLatencyMs} fallback=${state.fallbackUsed}`
  );

  return {};
}

// ─── Graph compilation ─────────────────────────────────────────────

function buildGraph() {
  const graph = new StateGraph(AgentAnnotation)
    .addNode("ingressNode", ingressNode)
    .addNode("routerNode", routerNode)
    .addNode("contextNode", contextNode)
    .addNode("llmNode", llmNode)
    .addNode("groundingNode", groundingNode)
    .addNode("responseNode", responseNode)
    .addNode("traceNode", traceNode)
    // ── Edges ──
    .addEdge(START, "ingressNode")
    .addConditionalEdges("ingressNode", afterIngress, {
      responseNode: "responseNode",
      routerNode: "routerNode",
    })
    .addConditionalEdges("routerNode", afterRouter, {
      responseNode: "responseNode",
      contextNode: "contextNode",
    })
    .addConditionalEdges("contextNode", afterContext, {
      responseNode: "responseNode",
      llmNode: "llmNode",
    })
    .addEdge("llmNode", "groundingNode")
    .addEdge("groundingNode", "responseNode")
    .addEdge("responseNode", "traceNode")
    .addEdge("traceNode", END);

  return graph.compile();
}

// ── Singleton compiled graph ───────────────────────────────────────

let _compiledGraph: ReturnType<typeof buildGraph> | null = null;

export function getCompiledGraph() {
  if (!_compiledGraph) {
    _compiledGraph = buildGraph();
  }
  return _compiledGraph;
}

// ─── Public API ────────────────────────────────────────────────────

export interface RunGraphResult {
  answer: string;
  traceId: string;
  handler: string;
  fallbackUsed: boolean;
  groundingConfidence: string;
  totalLatencyMs: number;
}

/**
 * Run the full pipeline for one chat turn.
 * This is the single entry point called by the Fastify route.
 */
export async function runChatPipeline(
  request: ChatRequest,
  sessionKey: string,
  cachedHistory: ChatHistoryMessage[]
): Promise<RunGraphResult> {
  const traceId = randomUUID();
  const startedAt = Date.now();

  const initialState = makeInitialState(request, sessionKey, cachedHistory, traceId);

  const graph = getCompiledGraph();
  const finalState = await graph.invoke(initialState);

  return {
    answer: finalState.answer ?? "I don't have enough context to answer right now.",
    traceId,
    handler: finalState.handlerDecision?.handler ?? "unknown",
    fallbackUsed: finalState.fallbackUsed ?? false,
    groundingConfidence: finalState.groundingConfidence ?? "grounded",
    totalLatencyMs: Date.now() - startedAt,
  };
}

/** For tests — reset the singleton so a fresh graph is built. */
export function resetCompiledGraph(): void {
  _compiledGraph = null;
}
