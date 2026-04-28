import type { ContextPacket, HandlerType } from "../handlers/chatHandler.js";
import { buildMemoryWindow } from "./memoryPolicy.js";
import { buildChatPromptDescriptor, buildRagPromptDescriptor } from "./promptRegistry.js";
import { applySmallModelBudget, buildChatMessages } from "./tokenBudgeter.js";
import { enforceGroundingGuard } from "./groundingGuard.js";
import type { BudgetReport } from "./tokenBudgeter.js";
import type { GroundingConfidence } from "./groundingGuard.js";
import { chatOnce, chatOnceWithModel } from "../llm/ollama.js";
import { config } from "../config.js";

type LiveContext = { source: string; text: string };
type RagContext = { text: string; chunkId: string; sourceUri?: string };
type RequestMessage = { role: "system" | "user" | "assistant"; content: string };
type HistoryMessage = { role: "user" | "assistant"; content: string; timestamp: number };

export interface PreparedTurn {
  promptId: string;
  promptVersion: string;
  systemPrompt: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  liveContexts: LiveContext[];
  ragContexts: RagContext[];
  estimatedTokens: number;
  budgetReport: BudgetReport;
  sessionState: {
    lastUserMessage: string | null;
    priorUserTurns: number;
    priorAssistantTurns: number;
  };
}

/** Result of a full LLM turn including grounding and fallback decisions. */
export interface LlmTurnResult {
  answer: string;
  confidence: GroundingConfidence;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  llmLatencyMs: number;
  retried: boolean;
}

// ─── Health / Health Helpers ──────────────────────────────────────────────────

export function deriveHealthFromLiveContexts(
  liveContexts: LiveContext[]
): "healthy" | "degraded" | "critical" | "unknown" {
  const alertBlock = liveContexts.find((c) => c.source === "alerts_db");
  const tagBlock = liveContexts.find((c) => c.source === "tags_db" || c.source === "tags_selected");

  if (!tagBlock && !alertBlock) return "unknown";
  if (alertBlock?.text) {
    if (/\[CRITICAL\].*status:\s*open/i.test(alertBlock.text)) return "critical";
    if (/\[WARNING\].*status:\s*open/i.test(alertBlock.text)) return "degraded";
  }
  if (tagBlock?.text && /:\s*1\s*\[/.test(tagBlock.text) && /(FAULT|ALARM_IND|EMG_STOP)/.test(tagBlock.text)) {
    return "degraded";
  }
  if (tagBlock?.text && !tagBlock.text.includes("No tags found")) return "healthy";
  return "unknown";
}

export function buildAvailableDataFallback(
  liveContexts: LiveContext[],
  health: "healthy" | "degraded" | "critical" | "unknown"
): string {
  const hasTags = liveContexts.some((c) => c.source === "tags_db" || c.source === "tags_selected");
  const hasAlerts = liveContexts.some((c) => c.source === "alerts_db");
  const hasReports = liveContexts.some((c) => c.source === "reports_db");
  const hasProduction = liveContexts.some((c) => c.source === "production_db");
  const parts: string[] = [];

  if (hasAlerts) parts.push("alerts");
  if (hasTags) parts.push("tag readings");
  if (hasProduction) parts.push("production metrics");
  if (hasReports) parts.push("report history");

  if (parts.length === 0) {
    return "I couldn't extract a reliable machine summary from the current context. Please ask for alerts, tags, or production metrics explicitly.";
  }
  const joined =
    parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Live data available: ${joined}. Current machine health: ${health}.`;
}

export function replaceUngroundedNoDataClaims(
  answer: string,
  hasLiveData: boolean,
  groundedFallback: string
): string {
  if (!hasLiveData) return answer;
  const badClaimPattern =
    /\b(tool[_\s-]*pipeline.*did(?:\s+not|n't)\s+respond|unable(?:\s+at\s+this\s+moment)?|cannot\s+provide.*real[-\s]*time|can't\s+provide.*live\s+data|try\s+again\s+later.*live\s+data|i\s+don't\s+have\s+enough\s+data\s+to\s+answer\s+that\s+right\s+now|no\s+(additional\s+)?production\s+data|halts?\s+production\s+operations?|no\s+further\s+production\s+data\s+can\s+be\s+provided)\b/i;
  return badClaimPattern.test(answer) ? groundedFallback : answer;
}

export function needsCitationGuard(answer: string, ragCount: number): string {
  if (ragCount === 0) return answer;
  if (/\[#\d+\]/.test(answer)) return answer;
  return `${answer}\n\n_No document citations detected — verify critical values against primary systems._`;
}

export function toolBlocksToLiveContexts(
  toolBlocks: { name: string; text: string }[]
): LiveContext[] {
  return toolBlocks
    .filter((b) => b.name !== "find_tags")
    .map((b) => ({
      source:
        b.name === "get_tags"
          ? "tags_db"
          : b.name === "get_alerts"
          ? "alerts_db"
          : b.name === "get_reports"
          ? "reports_db"
          : b.name === "get_production_metrics"
          ? "production_db"
          : `tool_${b.name}`,
      text: b.text,
    }));
}

// ─── Turn Preparation ─────────────────────────────────────────────────────────

export function prepareTurn(args: {
  useTwoPhase: boolean;
  contextPacket: ContextPacket;
  handler: HandlerType;
  reqMessages: RequestMessage[];
  cachedMessages: HistoryMessage[];
  liveContexts: LiveContext[];
  ragContexts: RagContext[];
}): PreparedTurn {
  const memory = buildMemoryWindow({
    requestMessages: args.reqMessages,
    cachedMessages: args.cachedMessages,
  });

  const prompt = args.useTwoPhase
    ? buildChatPromptDescriptor(args.contextPacket, "small-model")
    : buildRagPromptDescriptor(args.handler, args.ragContexts, args.liveContexts, "small-model");

  const budgeted = applySmallModelBudget({
    systemPrompt: prompt.systemPrompt,
    history: memory.messages,
    liveContexts: args.liveContexts,
    ragContexts: args.ragContexts,
  });

  return {
    promptId: prompt.id,
    promptVersion: prompt.version,
    systemPrompt: budgeted.systemPrompt,
    messages: buildChatMessages(budgeted.systemPrompt, budgeted.history),
    liveContexts: budgeted.liveContexts,
    ragContexts: budgeted.ragContexts,
    estimatedTokens: budgeted.estimatedTokens,
    budgetReport: budgeted.budgetReport,
    sessionState: memory.sessionState,
  };
}

// ─── LLM Call + Validation Chain ─────────────────────────────────────────────

/**
 * Executes the full LLM turn: model call → grounding guard → fallback selection.
 * Retries once with a 20% smaller prompt on timeout before failing.
 *
 * Contract: if groundingGuard returns confidence="insufficient", always uses
 * contextPacket.fallback — never lets a weakly grounded answer through.
 */
export async function runTurn(
  prepared: PreparedTurn,
  contextPacket: ContextPacket
): Promise<LlmTurnResult> {
  let llmLatencyMs = 0;
  let retried = false;
  let rawAnswer: string;

  const t0 = Date.now();

  const callModel = async (msgs: typeof prepared.messages): Promise<string> => {
    return chatOnce(msgs);
  };

  try {
    rawAnswer = await callModel(prepared.messages);
    llmLatencyMs = Date.now() - t0;
  } catch (firstErr: any) {
    const isTimeout =
      String(firstErr?.message ?? firstErr).includes("timeout") ||
      String(firstErr?.message ?? firstErr).includes("ECONNREFUSED");

    if (!isTimeout) throw firstErr;

    // Retry once with trimmed prompt (remove last RAG chunk)
    retried = true;
    const trimmedMessages = prepared.messages.map((m) => {
      if (m.role !== "system") return m;
      // Trim last ~20% of system prompt to reduce load
      const maxLen = Math.floor(m.content.length * 0.8);
      return { ...m, content: m.content.slice(0, maxLen) + "…" };
    });

    const t1 = Date.now();
    rawAnswer = await callModel(trimmedMessages);
    llmLatencyMs = Date.now() - t1;
  }

  // Run grounding guard
  const guardResult = enforceGroundingGuard(rawAnswer, contextPacket, prepared.liveContexts);

  // If insufficient confidence, use deterministic fallback — never let weak answer through
  if (guardResult.confidence === "insufficient" || guardResult.confidence === "contradicted") {
    return {
      answer: contextPacket.fallback,
      confidence: guardResult.confidence,
      fallbackUsed: true,
      fallbackReason: guardResult.reason,
      llmLatencyMs,
      retried,
    };
  }

  return {
    answer: guardResult.cleaned,
    confidence: guardResult.confidence,
    fallbackUsed: false,
    fallbackReason: null,
    llmLatencyMs,
    retried,
  };
}
