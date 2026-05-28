import type { FastifyBaseLogger } from "fastify";
import { executeLoggedTool } from "./tools.js";
import { normalizeToolArgsForQuery } from "./planner.js";
import { MAX_RETRIES, TOOL_TIMEOUT_MS } from "./constants.js";
import type { AgentToolStep, QueryClass } from "./types.js";

export function labelForTool(name: string): string {
  const labels: Record<string, string> = {
    get_live_tag_values: "Fetched selected live tags",
    get_all_live_tags: "Fetched all live machine tags",
    get_tag_history: "Loaded tag history",
    get_active_alerts: "Checked active alerts",
    get_alert_history: "Loaded alert history",
    get_tag_definition: "Checked tag thresholds",
    get_production_summary: "Built production summary",
    search_tags: "Searched tag definitions",
    get_machine_status: "Checked machine health",
    acknowledge_alert: "Acknowledged alert",
    get_chat_sessions: "Loaded chat sessions",
    get_tag_comparison: "Compared tag trends"
  };
  return labels[name] ?? `Ran ${name}`;
}

/** Stable cache key for a tool call — prevents duplicate DB hits within one request */
export function toolCacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
}

/** Wraps a promise with a hard timeout */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool timeout after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

export async function runTool(opts: {
  name: string;
  args: Record<string, unknown>;
  machineId: string;
  sessionId: string;
  logger: FastifyBaseLogger;
  cache: Map<string, unknown>;
  toolSteps: AgentToolStep[];
  toolsUsed: string[];
  queryClass: QueryClass;
  userMessage: string;
}): Promise<{ functionResponse: { name: string; response: { result?: unknown; error?: string } } }> {
  const { name, machineId, sessionId, logger, cache, toolSteps, toolsUsed, queryClass, userMessage } =
    opts;
  const args = normalizeToolArgsForQuery(name, opts.args, { queryClass, userMessage });
  const cacheKey = toolCacheKey(name, args);

  // Deduplication: same tool+args within one request returns cached result
  if (cache.has(cacheKey)) {
    toolSteps.push({
      tool: name,
      label: `${labelForTool(name)} (cached)`,
      args,
      durationMs: 0,
      status: "skipped",
      attempt: 0
    });
    console.log(`\x1b[32m[Agent Tool]\x1b[0m \x1b[36m[CACHED]\x1b[0m Tool "${name}" using cached result. Args:`, args);
    return { functionResponse: { name, response: { result: cache.get(cacheKey) } } };
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    console.log(`\x1b[32m[Agent Tool]\x1b[0m \x1b[33m[Attempt ${attempt}/${MAX_RETRIES}]\x1b[0m Invoking "${name}" with args:`, args);
    try {
      const result = await withTimeout(
        executeLoggedTool({ name, toolArgs: args, machineId, sessionId, logger }),
        TOOL_TIMEOUT_MS,
        name
      );
      const durationMs = Math.max(1, Date.now() - startedAt);
      cache.set(cacheKey, result);
      toolsUsed.push(name);
      toolSteps.push({ tool: name, label: labelForTool(name), args, durationMs, status: "success", attempt, result });
      console.log(`\x1b[32m[Agent Tool]\x1b[0m \x1b[32m[SUCCESS]\x1b[0m Tool "${name}" succeeded in ${durationMs}ms.`);
      return { functionResponse: { name, response: { result } } };
    } catch (error) {
      const durationMs = Math.max(1, Date.now() - startedAt);
      lastError = error instanceof Error ? error.message : String(error);
      const isTimeout = lastError.includes("timeout");
      const isFinal = attempt === MAX_RETRIES;

      if (isFinal) {
        toolsUsed.push(name);
        toolSteps.push({
          tool: name,
          label: `${labelForTool(name)} failed`,
          args,
          durationMs,
          status: isTimeout ? "timeout" : "error",
          attempt,
          error: lastError
        });
        console.error(`\x1b[31m[Agent Tool]\x1b[0m \x1b[31m[FAILED]\x1b[0m Tool "${name}" failed permanently after ${attempt} attempts in ${durationMs}ms. Error: ${lastError}`);
        return { functionResponse: { name, response: { error: lastError } } };
      }

      console.warn(`\x1b[33m[Agent Tool]\x1b[0m \x1b[33m[RETRYING]\x1b[0m Tool "${name}" failed on attempt ${attempt} in ${durationMs}ms. Retrying... Error: ${lastError}`);
      // Brief back-off before retry
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }

  // Should not reach here, but satisfies TypeScript
  return { functionResponse: { name, response: { error: lastError } } };
}
