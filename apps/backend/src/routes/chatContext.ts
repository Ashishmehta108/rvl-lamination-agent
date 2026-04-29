import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { desc, eq, and, gte } from "drizzle-orm";
import { getCachedOllamaModelNames } from "../llm/ollama.js";

/* ────────────────────────────────────────────────────────────────
   Live data fetcher for chat context injection.
   Instead of function-calling (too complex for 1B models), we
   detect intent from the user's message via keywords, then fetch
   relevant live data and format it as plain text for the LLM.
──────────────────────────────────────────────────────────────
*/

type LiveContext = { source: string; text: string };

export type LiveContextOptions = {
  tagIds?: string[];
};

/** Keywords that trigger each data source */
const ALERT_KEYWORDS = ["alert", "alerts", "fired", "warning", "critical", "open", "resolved", "acknowledged", "severity"];


const TAG_KEYWORDS = [
  "tag",
  "tags",
  "value",
  "values",
  "latest",
  "reading",
  "readings",
  "sensor",
  "nip",
  "pressure",
  "temperature",
  "speed"
];


const REPORT_KEYWORDS = ["report", "reports", "run", "runs", "performance", "summary", "metrics", "last report"];


const STATUS_KEYWORDS = [
  "dashboard",
  "overview",
  "status",
  "machine",
  "production",
  "line",
  "how is",
  "current state",
  "right now"
];            

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}              

async function fetchOllamaCatalogContext(): Promise<LiveContext | null> {
  const names = await getCachedOllamaModelNames();
  if (names.length === 0) {
    return {
      source: "ollama_catalog",
      text: "OLLAMA: Model list unavailable (Ollama not reachable or returned no models). Do not invent model names."
    };
  }
  return {
    source: "ollama_catalog",
    text: `OLLAMA (local inference server): installed model names (for configuration questions only, not machine readings):\n${names.map((n) => `- ${n}`).join("\n")}`
  };
}          
 
export async function fetchLiveContext(
  query: string,
  machineId: string,
  options?: LiveContextOptions
): Promise<LiveContext[]> {
  const results: LiveContext[] = [];
  const fetches: Promise<void>[] = [];
  const lowerQ = query.toLowerCase();
  const wantsModelCatalog =
    lowerQ.includes("ollama") ||
    lowerQ.includes("model") ||
    lowerQ.includes("llm") ||
    lowerQ.includes("phi4") ||
    lowerQ.includes("llama") ||
    lowerQ.includes("qwen");
  if (wantsModelCatalog) {
    fetches.push(fetchOllamaCatalogContext().then((r) => { if (r) results.push(r); }));
  }

  const wantAlerts =
    matchesAny(query, ALERT_KEYWORDS) || matchesAny(query, STATUS_KEYWORDS);
  const wantTags = true; // Always include latest tags for better grounding.
  const wantReports = matchesAny(query, REPORT_KEYWORDS);

  if (wantAlerts) {
    fetches.push(fetchAlerts(machineId).then((r) => { if (r) results.push(r); }));
  }

  if (wantTags) {
    fetches.push(fetchTags(machineId).then((r) => { if (r) results.push(r); }));
  }

  if (wantReports) {
    fetches.push(fetchReports(machineId).then((r) => { if (r) results.push(r); }));
  }

  const selected = options?.tagIds?.filter(Boolean) ?? [];
  if (selected.length > 0) {
    fetches.push(fetchSelectedTags(machineId, selected).then((r) => { if (r) results.push(r); }));
  }

  await Promise.allSettled(fetches);
  const priority: Record<string, number> = {
    tags_selected: 0,
    tags_db: 1,
    alerts_db: 2,
    reports_db: 3,
    ollama_catalog: 4
  };
  return results.sort((a, b) => (priority[a.source] ?? 99) - (priority[b.source] ?? 99));
}                  

async function fetchSelectedTags(machineId: string, tagIds: string[]): Promise<LiveContext | null> {
  try {
    const prisma = getMongoClient();
    const unique = [...new Set(tagIds)].slice(0, 24);
    const rows = await prisma.tagLatest.findMany({
      where: { machineId, tagId: { in: unique } }
    });
    const defs = await prisma.tagDefinition.findMany({
      where: { machineId, tagId: { in: unique } },
      select: { tagId: true, unit: true, name: true, slug: true }
    });
    const defMap = new Map(defs.map((d: any) => [d.tagId, d]));

    if (rows.length === 0) {
      return {
        source: "tags_selected",
        text: `SELECTED TAGS (requested by client): No latest values found for: ${unique.join(", ")} on machine "${machineId}".`
      };
    }

    const sorted = [...rows].sort((a: any, b: any) => {
      const ta = a.updatedAt?.getTime?.() ?? 0;
      const tb = b.updatedAt?.getTime?.() ?? 0;
      return tb - ta;
    });

    const lines = sorted.map((t: any) => {
      const val =
        t.valueNumber != null ? t.valueNumber : t.valueBool != null ? String(t.valueBool) : t.valueString ?? "N/A";
      const def = defMap.get(t.tagId) as any;
      const unit = (def?.unit || "").trim();
      const slug = (def?.slug || def?.name || t.tagId) as string;
      const iso = t.updatedAt?.toLocaleTimeString?.("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) ?? "N/A";
      const unitSeg = unit ? ` ${unit}` : "";
      return `* ${slug}: ${val}${unitSeg} [${iso}]`;
    });

    return {
      source: "tags_selected",
      text: `CURRENT TELEMETRY (requested tags):\n${lines.join("\n")}`
    };
  } catch {
    return null;
  }
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
        startsAt: schema.alertEvents.startsAt
      })
      .from(schema.alertEvents)
      .where(and(eq(schema.alertEvents.machineId, machineId), gte(schema.alertEvents.startsAt, since)))
      .orderBy(desc(schema.alertEvents.startsAt))
      .limit(20);

    if (alerts.length === 0) {
      return { source: "alerts_db", text: `LIVE ALERTS (last 7 days): No alerts found for machine "${machineId}".` };
    }

    const lines = alerts.map(
      (a, i) =>
        `ALERT #${i + 1}: [${a.severity?.toUpperCase()}] status: ${a.status} | title: "${a.title}" | description: "${a.description ?? "none"}" | detected at: ${a.startsAt?.toLocaleString?.("en-IN", { timeZone: "Asia/Kolkata" }) ?? "N/A"}`
    );

    return {
      source: "alerts_db",
      text: `ACTIVE ALERTS (last 7 days):\n${lines.join("\n")}`
    };
  } catch {
    return null;
  }
}               

async function fetchTags(machineId: string): Promise<LiveContext | null> {
  try {
    const prisma = getMongoClient();
    const tags = await prisma.tagLatest.findMany({
      where: { machineId },
      orderBy: { updatedAt: "desc" },
      take: 30
    });

    if (tags.length === 0) {
      return { source: "tags_db", text: `LIVE TAG VALUES: No tags found for machine "${machineId}".` };
    }

    const defs = await prisma.tagDefinition.findMany({
      where: { machineId },
      select: { tagId: true, unit: true, name: true, slug: true }
    });
    const defMap = new Map(defs.map((d: any) => [d.tagId, d]));

    const lines = tags.map((t: any) => {
      const val =
        t.valueNumber != null ? t.valueNumber : t.valueBool != null ? String(t.valueBool) : t.valueString ?? "N/A";
      const def = defMap.get(t.tagId) as any;
      const unit = (def?.unit || "").trim();
      const slug = (def?.slug || def?.name || t.tagId) as string;
      const iso = t.updatedAt?.toLocaleTimeString?.("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) ?? "N/A";
      const unitSeg = unit ? ` ${unit}` : "";
      return `* ${slug}: ${val}${unitSeg} [${iso}]`;
    });

    return {
      source: "tags_db",
      text: `MACHINE STATE SNAPSHOT (most recent first):\n${lines.join("\n")}`
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
        createdAt: schema.reportRuns.createdAt
      })
      .from(schema.reportRuns)
      .where(eq(schema.reportRuns.machineId, machineId))
      .orderBy(desc(schema.reportRuns.createdAt))
      .limit(5);

    if (runs.length === 0) {
      return { source: "reports_db", text: `REPORTS: No report runs found for machine "${machineId}".` };
    }

    const lines = runs.map(
      (r, i) =>
        `${i + 1}. [${r.status}] Window: ${r.windowStart?.toLocaleString?.("en-IN", { timeZone: "Asia/Kolkata" })} -> ${r.windowEnd?.toLocaleString?.("en-IN", { timeZone: "Asia/Kolkata" })} | Metrics: ${JSON.stringify(r.metrics)} (created: ${r.createdAt?.toLocaleString?.("en-IN", { timeZone: "Asia/Kolkata" })})`
    );

    return {
      source: "reports_db",
      text: `REPORTS (last ${runs.length} runs for machine "${machineId}"):\n${lines.join("\n")}`
    };
  } catch {
    return null;
  }
}                  
