import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { desc, eq, and, gte } from "drizzle-orm";

/* ────────────────────────────────────────────────────────────────
   Live data fetcher for chat context injection.
   Instead of function-calling (too complex for 1B models), we
   detect intent from the user's message via keywords, then fetch
   relevant live data and format it as plain text for the LLM.
   ──────────────────────────────────────────────────────────────── */

type LiveContext = { source: string; text: string };

/** Keywords that trigger each data source */
const ALERT_KEYWORDS = ["alert", "alerts", "fired", "warning", "critical", "open", "resolved", "acknowledged", "severity"];
const TAG_KEYWORDS = ["tag", "tags", "value", "values", "latest", "reading", "readings", "sensor", "nip", "pressure", "temperature", "speed"];
const REPORT_KEYWORDS = ["report", "reports", "run", "runs", "performance", "summary", "metrics", "last report"];

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

export async function fetchLiveContext(query: string, machineId: string): Promise<LiveContext[]> {
  const results: LiveContext[] = [];
  const fetches: Promise<void>[] = [];

  if (matchesAny(query, ALERT_KEYWORDS)) {
    fetches.push(fetchAlerts(machineId).then(r => { if (r) results.push(r); }));
  }

  if (matchesAny(query, TAG_KEYWORDS)) {
    fetches.push(fetchTags(machineId).then(r => { if (r) results.push(r); }));
  }

  if (matchesAny(query, REPORT_KEYWORDS)) {
    fetches.push(fetchReports(machineId).then(r => { if (r) results.push(r); }));
  }

  await Promise.allSettled(fetches);
  return results;
}

async function fetchAlerts(machineId: string): Promise<LiveContext | null> {
  try {
    const db = getPgDb();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days
    const alerts = await db
      .select({
        id: schema.alertEvents.id,
        severity: schema.alertEvents.severity,
        status: schema.alertEvents.status,
        title: schema.alertEvents.title,
        description: schema.alertEvents.description,
        startsAt: schema.alertEvents.startsAt,
      })
      .from(schema.alertEvents)
      .where(and(
        eq(schema.alertEvents.machineId, machineId),
        gte(schema.alertEvents.startsAt, since)
      ))
      .orderBy(desc(schema.alertEvents.startsAt))
      .limit(20);

    if (alerts.length === 0) {
      return { source: "alerts_db", text: `LIVE ALERTS (last 7 days): No alerts found for machine "${machineId}".` };
    }

    const lines = alerts.map((a, i) =>
      `${i + 1}. [${a.severity?.toUpperCase()}] [${a.status}] "${a.title}" - ${a.description ?? "no description"} (${a.startsAt?.toISOString?.() ?? "unknown time"})`
    );

    return {
      source: "alerts_db",
      text: `LIVE ALERTS (last 7 days, ${alerts.length} found for machine "${machineId}"):\n${lines.join("\n")}`
    };
  } catch {
    return null;
  }
}

async function fetchTags(machineId: string): Promise<LiveContext | null> {
  try {
    const prisma = getMongoClient();
    const tags = await prisma.tagLatest.findMany({ where: { machineId }, take: 50 });

    if (tags.length === 0) {
      return { source: "tags_db", text: `LIVE TAG VALUES: No tags found for machine "${machineId}".` };
    }

    // Get tag definitions for units
    const defs = await prisma.tagDefinition.findMany({
      where: { machineId },
      select: { tagId: true, unit: true, name: true }
    });
    const defMap = new Map(defs.map((d: any) => [d.tagId, d]));

    const lines = tags.map((t: any) => {
      const val = t.valueNumber != null ? t.valueNumber
        : t.valueBool != null ? String(t.valueBool)
        : t.valueString ?? "N/A";
      const def = defMap.get(t.tagId) as any;
      const unit = def?.unit || "";
      const name = def?.name || t.tagId;
      return `- ${name} (${t.tagId}): ${val}${unit ? " " + unit : ""} [updated: ${t.updatedAt?.toISOString?.() ?? "unknown"}]`;
    });

    return {
      source: "tags_db",
      text: `LIVE TAG VALUES (${tags.length} tags for machine "${machineId}"):\n${lines.join("\n")}`
    };
  } catch {
    return null;
  }
}

async function fetchReports(machineId: string): Promise<LiveContext | null> {
  try {
    const db = getPgDb();
    const runs = await db
      .select({
        id: schema.reportRuns.id,
        status: schema.reportRuns.status,
        windowStart: schema.reportRuns.windowStart,
        windowEnd: schema.reportRuns.windowEnd,
        metrics: schema.reportRuns.metrics,
        createdAt: schema.reportRuns.createdAt,
      })
      .from(schema.reportRuns)
      .where(eq(schema.reportRuns.machineId, machineId))
      .orderBy(desc(schema.reportRuns.createdAt))
      .limit(5);

    if (runs.length === 0) {
      return { source: "reports_db", text: `REPORTS: No report runs found for machine "${machineId}".` };
    }

    const lines = runs.map((r, i) =>
      `${i + 1}. [${r.status}] Window: ${r.windowStart?.toISOString?.()} -> ${r.windowEnd?.toISOString?.()} | Metrics: ${JSON.stringify(r.metrics)} (created: ${r.createdAt?.toISOString?.()})`
    );

    return {
      source: "reports_db",
      text: `REPORTS (last ${runs.length} runs for machine "${machineId}"):\n${lines.join("\n")}`
    };
  } catch {
    return null;
  }
}
