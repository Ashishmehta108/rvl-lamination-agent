/**
 * agent/types.ts
 * ─────────────────────────────────────────────────────────────────
 * Strict Zod-validated graph state.
 * Every node in the LangGraph reads from and writes to this shape.
 * No field is optional unless it genuinely may be absent at that
 * stage of the pipeline.
 * ─────────────────────────────────────────────────────────────────
 */

import { z } from "zod";
import type {
  NormalizedInput,
  RiskAssessment,
  IntentSignals,
  ContextAssessment,
  HandlerDecision,
  ContextPacket,
} from "../handlers/chatHandler.js";
import type { GroundingConfidence } from "../services/groundingGuard.js";
import type { ChatHistoryMessage } from "../services/chatHistoryCache.js";
import type { ChatToolCall } from "../services/chatTools.js";

// ─── Request (ingress) ────────────────────────────────────────────

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  machineId: z.string().min(1).max(100),
  sessionId: z.string().max(120).optional(),
  tagIds: z.array(z.string().max(80)).max(40).optional(),
  /** ISO timestamp of when the request arrived at the API boundary */
  requestedAt: z.string().datetime().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// ─── Tool result ──────────────────────────────────────────────────

export interface ToolBlock {
  name: string;
  text: string;
}

// ─── Live context ─────────────────────────────────────────────────

export interface LiveContext {
  source: string;
  text: string;
}

// ─── Graph state ──────────────────────────────────────────────────

/**
 * The complete state object threaded through every node.
 * Fields start null and are populated as the pipeline progresses.
 * No node may clear a field set by an earlier node.
 */
export interface AgentState {
  // ── Ingress ──
  request: ChatRequest;
  sessionKey: string;
  cachedHistory: ChatHistoryMessage[];

  // ── Normalization ──
  normalized: NormalizedInput | null;
  risk: RiskAssessment | null;

  // ── Router ──
  intent: IntentSignals | null;
  contextAssessment: ContextAssessment | null;
  handlerDecision: HandlerDecision | null;

  // ── Context / tools ──
  toolCalls: ChatToolCall[];
  toolBlocks: ToolBlock[];
  liveContexts: LiveContext[];
  contextPacket: ContextPacket | null;
  health: "healthy" | "degraded" | "critical" | "unknown";

  // ── LLM turn ──
  rawLlmAnswer: string | null;
  llmLatencyMs: number;
  retried: boolean;

  // ── Grounding + validation ──
  groundingConfidence: GroundingConfidence | null;
  groundingReason: string | null;
  validationPassed: boolean;
  fallbackUsed: boolean;
  fallbackReason: string | null;

  // ── Style rewrite ──
  styleRewriteApplied: boolean;

  // ── Final answer ──
  answer: string | null;

  // ── Observability ──
  traceId: string;
  startedAt: number;
  promptId: string;
  promptVersion: string;
  budgetTrimmedSources: string[];
  ragChunkCount: number;
  liveContextSources: string[];
  estimatedTokens: number;
}

// ─── Initial state factory ────────────────────────────────────────

export function makeInitialState(
  request: ChatRequest,
  sessionKey: string,
  cachedHistory: ChatHistoryMessage[],
  traceId: string
): AgentState {
  return {
    request,
    sessionKey,
    cachedHistory,

    normalized: null,
    risk: null,

    intent: null,
    contextAssessment: null,
    handlerDecision: null,

    toolCalls: [],
    toolBlocks: [],
    liveContexts: [],
    contextPacket: null,
    health: "unknown",

    rawLlmAnswer: null,
    llmLatencyMs: 0,
    retried: false,

    groundingConfidence: null,
    groundingReason: null,
    validationPassed: false,
    fallbackUsed: false,
    fallbackReason: null,

    styleRewriteApplied: false,

    answer: null,

    traceId,
    startedAt: Date.now(),
    promptId: "none",
    promptVersion: "v1",
    budgetTrimmedSources: [],
    ragChunkCount: 0,
    liveContextSources: [],
    estimatedTokens: 0,
  };
}
