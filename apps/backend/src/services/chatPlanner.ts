import { z } from "zod";
import type { ChatToolCall } from "./chatTools.js";

export const ChatPlannerSchema = z.object({
  tools: z
    .array(
      z.object({
        name: z.enum(["find_tags", "get_tags", "get_alerts", "get_reports", "get_production_metrics"]),
        args: z.record(z.unknown()).optional()
      })
    )
    .max(4)
});

/**
 * Compact planner prompt targeting < 300 tokens.
 * Explanatory prose removed — schema + rules only.
 */
export const PLANNER_SYSTEM = `You are a tool planner for an industrial lamination machine assistant.
Output ONLY a raw JSON object. No markdown. No explanation. No code fences.

SCHEMA (follow exactly):
{"tools":[{"name":"<tool_name>","args":{<args>}}]}

AVAILABLE TOOLS:

find_tags       args: {"query":"<search phrase>"}
get_tags        args: {"tagIds":["id1","id2"],"limit":10}
get_alerts      args: {"includeRecentClosed":false}
get_reports     args: {"limit":5}
get_production_metrics  args: {"granularity":"daily","buckets":7}

RULES:
- alerts/warning/fault/critical → get_alerts with includeRecentClosed:false
- sensor/tag/reading/value/rpm/speed/tension → find_tags, then get_tags
- report/performance/summary → get_reports
- production/output/meters/daily/weekly/monthly → get_production_metrics
- status/overview/how is machine → get_alerts + get_tags
- max 3 tools; prefer smallest useful plan
- vague query → get_alerts only

EXAMPLES:

User: "what are the alerts"
{"tools":[{"name":"get_alerts","args":{"includeRecentClosed":false}}]}

User: "show winder amps"
{"tools":[{"name":"find_tags"},{"name":"get_tags","args":{"tagIds":[],"limit":5}}]}

User: "give me the production report"
{"tools":[{"name":"get_reports","args":{"limit":5}}]}

User: "how is the machine"
{"tools":[{"name":"get_alerts","args":{"includeRecentClosed":false}},{"name":"get_tags","args":{"tagIds":[],"limit":10}}]}`;
/**
 * Tries to extract a valid JSON object from partial or fence-wrapped LLM output.
 * Called before JSON.parse so small model formatting glitches don't silently fail.
 */
export function repairPlannerJson(raw: string): string | null {
  // Remove markdown fences first
  let t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // If it parses cleanly, return as-is
  try {
    JSON.parse(t);
    return t;
  } catch { /* fall through to repair */ }

  // Try to extract the first {...} block
  const match = /\{[\s\S]*\}/.exec(t);
  if (!match) return null;

  try {
    JSON.parse(match[0]);
    return match[0];
  } catch {
    return null;
  }
}

export function stripJsonFence(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return t.trim();
}

/**
 * Validates a parsed plan:
 * - max 4 tools
 * - no unknown tool names
 * Returns true if valid, false if should fall back to defaultToolPlan.
 */
export function validatePlan(plan: z.infer<typeof ChatPlannerSchema>): boolean {
  if (!plan?.tools || plan.tools.length === 0) return false;
  if (plan.tools.length > 4) return false;
  const allowed = new Set(["find_tags", "get_tags", "get_alerts", "get_reports", "get_production_metrics"]);
  return plan.tools.every((t) => allowed.has(t.name));
}

export function parsePlannerJson(raw: string): z.infer<typeof ChatPlannerSchema> | null {
  // Try repair first — handles partial JSON and markdown-wrapped output
  const repaired = repairPlannerJson(raw);
  if (!repaired) return null;

  try {
    const parsed = JSON.parse(repaired);
    const r = ChatPlannerSchema.safeParse(parsed);
    if (!r.success) return null;
    if (!validatePlan(r.data)) return null;
    return r.data;
  } catch {
    return null;
  }
}

export function wantsToolPipeline(userText: string, clientTagIds?: string[]): boolean {
  if (clientTagIds && clientTagIds.length > 0) return true;
  const q = userText.trim();
  if (q.length < 2) return false;
  if (isGreetingOnly(q)) return false;
  const l = q.toLowerCase();
  return (
    /\b(alert|alerts|warning|critical|open alert|fired)\b/.test(l) ||
    /\b(report|reports|run|runs|performance summary)\b/.test(l) ||
    /\b(tag|tags|sensor|reading|readings|rpm|meter|gsm|tension|winder|extruder|laminator|production|metric|daily|weekly|monthly)\b/.test(l) ||
    /\b(machine|lamination|line|status|how is|current)\b/.test(l) ||
    q.length > 80
  );
}

function isGreetingOnly(q: string): boolean {
  const t = q.trim().toLowerCase();
  if (t.length > 80) return false;
  return /^(hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening)\b[!?.]*$/i.test(t);
}

/** Heuristic fallback if the model returns invalid JSON. */
export function defaultToolPlan(userQuery: string, clientTagIds?: string[]): ChatToolCall[] {
  const q = userQuery.toLowerCase();
  const tools: ChatToolCall[] = [];

  if (clientTagIds?.length) {
    tools.push({ name: "get_tags", args: { tagIds: clientTagIds.slice(0, 24) } });
  }

  if (
    /\b(find|which|what|show)\b.*\b(tag|sensor)\b|\b(tag|sensor)\b.*\b(winder|extruder|rpm|tension|gsm|meter|speed)\b/i.test(
      userQuery
    )
  ) {
    tools.push({ name: "find_tags", args: { query: userQuery.slice(0, 200) } });
  }

  if (/\b(alert|alerts|warning|critical|fired)\b/.test(q)) {
    tools.push({ name: "get_alerts", args: { includeRecentClosed: true } });
  }

  if (/\b(report|reports|run|runs)\b/.test(q)) {
    tools.push({ name: "get_reports", args: { limit: 8 } });
  }

  if (/\b(production|metric|rollup|daily|weekly|monthly|trend)\b/.test(q)) {
    tools.push({ name: "get_production_metrics", args: { granularity: "daily", buckets: 14 } });
  }

  if (!tools.some((t) => t.name === "get_tags")) {
    tools.push({ name: "get_tags", args: { limit: 28 } });
  }

  return tools.slice(0, 4);
}
