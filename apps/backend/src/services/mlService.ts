/**
 * ML Service client.
 * Provides typed wrappers for calling the Python ML micro-server.
 * Falls back gracefully when the ML server is not running.
 */

import { config } from "../config.js";

const ML_BASE_URL = process.env["ML_SERVER_URL"] ?? "http://127.0.0.1:7100";
const ML_TIMEOUT_MS = 5_000;

export interface MlPredictResult {
  is_anomaly: boolean;
  score: number;
  threshold: number;
  anomalous_tags: string[];
  tag_scores: Record<string, number>;
  missing_tags: string[];
  alert_id?: string | null;
  scored_at: string;
}

export interface MlStatusResult {
  deploy_time: string;
  baseline: {
    status: string;
    rows: number;
    time_range?: { start: string; end: string };
  };
  model: {
    status: string;
    trained_at?: string;
    training_rows?: number;
    numeric_tags?: string[];
  };
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: object
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);
  try {
    const res = await fetch(`${ML_BASE_URL}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Send a tag snapshot to the ML server for collection + anomaly scoring. */
export async function mlCollectAndPredict(
  timestamp: string,
  tags: Record<string, unknown>
): Promise<MlPredictResult | null> {
  // Fire-and-forget collect (no await)
  void call("POST", "/collect", { timestamp, tags });
  // Predict synchronously (returns null if server unavailable)
  return call<MlPredictResult>("POST", "/predict", { timestamp, tags });
}

/** Trigger background retraining on the ML server. */
export async function mlTriggerRetrain(force = false): Promise<boolean> {
  const res = await call<{ ok: boolean }>("POST", "/retrain", { force });
  return res?.ok === true;
}

/** Get current ML model + baseline status. */
export async function mlGetStatus(): Promise<MlStatusResult | null> {
  return call<MlStatusResult>("GET", "/status");
}
