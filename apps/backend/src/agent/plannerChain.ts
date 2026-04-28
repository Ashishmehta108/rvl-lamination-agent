/**
 * agent/plannerChain.ts
 * ─────────────────────────────────────────────────────────────────
 * LangChain chain for the planner step.
 *
 * Replaces the raw chatOnce(PLANNER_SYSTEM) call in the current route.
 * Chain: ChatOllama → StringOutputParser → ChatPlannerSchema.safeParse
 *
 * Contract:
 * - Always returns a valid ChatToolCall[]. Never throws.
 * - Falls back to defaultToolPlan() if the model returns invalid JSON
 *   or if the chain itself errors.
 * - The model's output is validated against ChatPlannerSchema (Zod).
 * - Resilience transform for non-standard JSON shapes is preserved.
 * ─────────────────────────────────────────────────────────────────
 */

import { ChatOllama } from "@langchain/ollama";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { config } from "../config.js";
import {
  PLANNER_SYSTEM,
  ChatPlannerSchema,
  parsePlannerJson,
  defaultToolPlan,
} from "../services/chatPlanner.js";
import type { ChatToolCall } from "../services/chatTools.js";

// ─── Singleton model (planner uses same model as chat) ─────────────

let _plannerModel: ChatOllama | null = null;

function getPlannerModel(): ChatOllama {
  if (!_plannerModel) {
    _plannerModel = new ChatOllama({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      temperature: 0, // deterministic JSON — never increase
      numCtx: config.ollamaNumCtx,
      keepAlive: config.ollamaKeepAlive,
    });
  }
  return _plannerModel;
}

/** Inject a mock model for tests. */
export function setPlannerModel(model: ChatOllama): void {
  _plannerModel = model;
}

// ─── Chain ─────────────────────────────────────────────────────────

const parser = new StringOutputParser();

/**
 * Run the planner chain.
 * Returns validated tool calls, or defaultToolPlan() on any failure.
 * Never throws to the caller.
 */
export async function runPlannerChain(
  userQuery: string,
  clientTagIds?: string[]
): Promise<ChatToolCall[]> {
  try {
    const model = getPlannerModel();

    const messages = [
      new SystemMessage(PLANNER_SYSTEM),
      new HumanMessage(userQuery.slice(0, 600)),
    ];

    const withTimeout = Promise.race<string>([
      model.pipe(parser).invoke(messages),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("planner_timeout")),
          Math.min(config.llmTimeoutMs, 20_000)
        )
      ),
    ]);

    const raw = await withTimeout;

    const parsed = parsePlannerJson(raw);
    if (!parsed) {
      console.warn("[plannerChain] model returned invalid JSON — using defaultToolPlan");
      return defaultToolPlan(userQuery, clientTagIds);
    }

    // Validate the parsed result against the full schema
    const result = ChatPlannerSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("[plannerChain] schema validation failed — using defaultToolPlan", result.error.flatten());
      return defaultToolPlan(userQuery, clientTagIds);
    }

    // Map schema output to ChatToolCall[]
    const calls: ChatToolCall[] = result.data.tools.map((t) => ({
      name: t.name,
      args: (t.args ?? {}) as Record<string, unknown>,
    }));

    console.log(`[plannerChain] plan: ${calls.map((c) => c.name).join(", ") || "(none)"}`);
    return calls;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[plannerChain] chain error (${msg}) — using defaultToolPlan`);
    return defaultToolPlan(userQuery, clientTagIds);
  }
}
