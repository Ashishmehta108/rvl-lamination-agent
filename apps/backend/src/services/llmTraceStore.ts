// NOTE: Postgres persistence is stubbed until the `llm_traces` migration is added to
// packages/db-postgres. Add the table schema + migration, then uncomment the DB flush below.
// import { getPgDb, schema } from "@rvl/db-postgres";

import type { GroundingConfidence } from "./groundingGuard.js";
import type { HandlerType } from "../handlers/chatHandler.js";

export interface LlmTrace {
  traceId: string;
  sessionKey: string;
  machineId: string;
  timestamp: number;
  promptId: string;
  promptVersion: string;
  modelUsed: string;
  handler: HandlerType;
  estimatedTokens: number;
  budgetTrimmedSources: string[];
  liveContextSources: string[];
  ragChunkCount: number;
  groundingConfidence: GroundingConfidence;
  validationPassed: boolean;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  styleRewriteApplied: boolean;
  llmLatencyMs: number;
  totalLatencyMs: number;
  retried: boolean;
  /** First 200 chars of final answer for quick debugging — never full PII */
  answerPreview: string;
}

/** In-memory ring buffer as a hot cache — flushed to Postgres asynchronously. */
const ringBuffer: LlmTrace[] = [];
const RING_MAX = 100;

let pgFlushPending = false;
const pgFlushQueue: LlmTrace[] = [];

/** Record a trace — writes to ring buffer immediately, flushes to Postgres async. */
export function recordTrace(trace: LlmTrace): void {
  // Ring buffer (hot cache for /traces endpoint)
  if (ringBuffer.length >= RING_MAX) ringBuffer.shift();
  ringBuffer.push(trace);

  // Queue for Postgres persistence
  pgFlushQueue.push(trace);
  if (!pgFlushPending) {
    pgFlushPending = true;
    // Fire-and-forget — never blocks the response path
    setImmediate(() => void flushToPg());
  }
}

async function flushToPg(): Promise<void> {
  const batch = pgFlushQueue.splice(0, pgFlushQueue.length);
  if (batch.length === 0) {
    pgFlushPending = false;
    return;
  }

  try {
    // TODO: Uncomment once the `llm_traces` table migration is added to packages/db-postgres:
    //
    // const db = getPgDb();
    // await db.insert(schema.llmTraces).values(
    //   batch.map((t) => ({
    //     id: t.traceId,
    //     sessionKey: t.sessionKey,
    //     machineId: t.machineId,
    //     createdAt: new Date(t.timestamp),
    //     payload: t as any,
    //   }))
    // ).onConflictDoNothing();
    //
    // Until then, traces live in the ring buffer only (last 100 turns).
    void batch; // suppress unused warning
  } catch {
    // Postgres unavailable — traces survive in ring buffer only
  } finally {
    pgFlushPending = false;
    if (pgFlushQueue.length > 0) {
      pgFlushPending = true;
      setImmediate(() => void flushToPg());
    }
  }
}

/** Returns the last N traces from the hot ring buffer (fast, no DB). */
export function getRecentTraces(limit = 20): LlmTrace[] {
  return ringBuffer.slice(-Math.min(limit, RING_MAX)).reverse();
}

export function getTraceById(traceId: string): LlmTrace | null {
  return ringBuffer.find((t) => t.traceId === traceId) ?? null;
}
