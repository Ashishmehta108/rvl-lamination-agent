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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export const PLANNER_SYSTEM = `You are a planner for an industrial lamination assistant. Output ONLY valid JSON (no markdown fences, no prose).
Today's date: ${todayISO()}

Schema:
{"tools":[{"name":"<tool>","args":{...}}, ...]}

Allowed tools and args:
- find_tags: { "query": "<user phrase or tag name fragment>" }
- get_tags: { "tagIds"?: ["<mongo tagId>", ...], "limit"?: number }  // omit tagIds for latest snapshot
- get_alerts: { "includeRecentClosed"?: boolean, "from"?: "<ISO date>", "to"?: "<ISO date>" }  // from/to for historical queries (e.g. "alerts on 23 April" → from="2026-04-23", to="2026-04-24")
- get_reports: { "limit"?: number }
- get_production_metrics: { "granularity"?: "daily"|"weekly"|"monthly", "buckets"?: number, "from"?: "<ISO date>", "to"?: "<ISO date>" }

Rules:
- If the user asks about alerts, include get_alerts. If they mention a specific date, set from/to accordingly.
- If they ask about a specific sensor/tag by name, include find_tags with their wording then get_tags.
- If they ask about reports/history, include get_reports.
- If they ask about production rollups/trends, include get_production_metrics.
- If they mention a date for production (e.g. "production on 25 April"), set from/to on get_production_metrics.
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
    /\b(yesterday|today|last\s+(week|month)|(\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))\b/i.test(l) ||
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

/* ── Date extraction for fallback tool plans ── */

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
//

/**
 * Extract a date range from the user query.
 * Handles: "23 april", "april 23", "yesterday", "last week", "last month",
 *           "25th april", "on 23/04", "on 2026-04-23"
 * Returns null if no date is detected.
 */
export function extractDateRange(query: string): { from: string; to: string } | null {
  const q = query.toLowerCase().trim();
  const now = new Date();
  const year = now.getFullYear();

  // Helper to format local date as YYYY-MM-DD without UTC shift
  const toDateStr = (d: Date) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  // "yesterday"
  if (/\byesterday\b/.test(q)) {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    const from = toDateStr(d);
    const to = toDateStr(new Date(d.getTime() + 86400000));
    return { from, to };
  }

  // "last week"
  if (/\blast\s+week\b/.test(q)) {
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return { from: toDateStr(start), to: toDateStr(now) };
  }

  // "last month"
  if (/\blast\s+month\b/.test(q)) {
    const start = new Date(now); start.setMonth(start.getMonth() - 1);
    return { from: toDateStr(start), to: toDateStr(now) };
  }

  // "23 april", "23rd april", "april 23", "23 apr"
  const dateMonth = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
  const monthDate = q.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);

  const m = dateMonth || monthDate;
  if (m) {
    const day = dateMonth ? parseInt(m[1]!) : parseInt(m[2]!);
    const monthStr = (dateMonth ? m[2]! : m[1]!).toLowerCase();
    const month = MONTH_MAP[monthStr];
    if (month !== undefined && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      // If the date is in the future, use last year
      if (d.getTime() > now.getTime() + 86400000) d.setFullYear(year - 1);
      const from = toDateStr(d);
      const to = toDateStr(new Date(d.getTime() + 86400000));
      return { from, to };
    }
  }

  // ISO date: "2026-04-23"
  const iso = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && !Number.isNaN(Date.parse(iso[1]!))) {
    const d = new Date(iso[1]!);
    return { from: iso[1]!, to: new Date(d.getTime() + 86400000).toISOString().slice(0, 10) };
  }

  return null;
}

/** Heuristic fallback if the model returns invalid JSON. */
export function defaultToolPlan(userQuery: string, clientTagIds?: string[]): ChatToolCall[] {
  const q = userQuery.toLowerCase();
  const tools: ChatToolCall[] = [];
  const dateRange = extractDateRange(userQuery);

  if (clientTagIds?.length) {
    tools.push({ name: "get_tags", args: { tagIds: clientTagIds.slice(0, 24) } });
  }

  if (/\b(find|which|what|show)\b.*\b(tag|sensor)\b|\b(tag|sensor)\b.*\b(winder|extruder|rpm|tension|gsm|meter|speed)\b/i.test(userQuery)) {
    tools.push({ name: "find_tags", args: { query: userQuery.slice(0, 200) } });
  }

  if (/\b(alert|alerts|warning|critical|fired)\b/.test(q)) {
    const alertArgs: Record<string, unknown> = { includeRecentClosed: true };
    if (dateRange) {
      alertArgs.from = dateRange.from;
      alertArgs.to = dateRange.to;
    }
    tools.push({ name: "get_alerts", args: alertArgs });
  }

  if (/\b(report|reports|run|runs)\b/.test(q)) {
    tools.push({ name: "get_reports", args: { limit: 8 } });
  }

  // Auto-include production metrics for status, report, alerts, and explicit production queries
  const wantsProduction =
    /\b(production|metric|rollup|daily|weekly|monthly|trend|output|throughput|efficiency|meters|alert|alerts)\b/.test(q) ||
    /\b(status|overview|how\s+is|machine|running|report|reports)\b/.test(q);

  if (wantsProduction) {
    const prodArgs: Record<string, unknown> = { granularity: "daily", buckets: 7 };
    if (dateRange) {
      prodArgs.from = dateRange.from;
      prodArgs.to = dateRange.to;
    }
    tools.push({ name: "get_production_metrics", args: prodArgs });
  }

  if (!tools.some((t) => t.name === "get_tags")) {
    tools.push({ name: "get_tags", args: { limit: 28 } });
  }

  return tools.slice(0, 8);
}
