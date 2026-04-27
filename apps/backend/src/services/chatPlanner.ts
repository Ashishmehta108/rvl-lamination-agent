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
    .max(8)
});

export const PLANNER_SYSTEM = `You are a planner for an industrial lamination assistant. Output ONLY valid JSON (no markdown fences, no prose).

Schema:
{"tools":[{"name":"<tool>","args":{...}}, ...]}

Allowed tools and args:
- find_tags: { "query": "<user phrase or tag name fragment>" }
- get_tags: { "tagIds"?: ["<mongo tagId>", ...], "limit"?: number }  // omit tagIds for latest snapshot
- get_alerts: { "includeRecentClosed"?: boolean }  // default true
- get_reports: { "limit"?: number }
- get_production_metrics: { "granularity"?: "daily"|"weekly"|"monthly", "buckets"?: number }

Rules:
- If the user asks about alerts, include get_alerts.
- If they ask about a specific sensor/tag by name, include find_tags with their wording then get_tags with the returned tagIds (you may omit get_tags if you only find_tags — the server will still run get_tags if needed).
- If they ask about reports/history, include get_reports.
- If they ask about production rollups/trends, include get_production_metrics.
- Keep the plan minimal (usually 2–5 tools).`;

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

export function stripJsonFence(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return t.trim();
}

export function parsePlannerJson(raw: string): z.infer<typeof ChatPlannerSchema> | null {
  const t = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(t);
    const r = ChatPlannerSchema.safeParse(parsed);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Heuristic fallback if the model returns invalid JSON. */
export function defaultToolPlan(userQuery: string, clientTagIds?: string[]): ChatToolCall[] {
  const q = userQuery.toLowerCase();
  const tools: ChatToolCall[] = [];

  if (clientTagIds?.length) {
    tools.push({ name: "get_tags", args: { tagIds: clientTagIds.slice(0, 24) } });
  }

  if (/\b(find|which|what|show)\b.*\b(tag|sensor)\b|\b(tag|sensor)\b.*\b(winder|extruder|rpm|tension|gsm|meter|speed)\b/i.test(userQuery)) {
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

  return tools.slice(0, 8);
}
