import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { and, desc, eq, gte, lte, ne } from "drizzle-orm";
import { aggregateProductionMetrics, type ProductionGranularity } from "./productionMetrics.js";

export type FindTagCandidate = { tagId: string; slug: string; name: string; unit: string | null; score: number };

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Parses 'YYYY-MM-DD' or similar as local midnight. Avoids UTC shift bugs. */
function parseLocalDate(s: string): Date {
  if (!s) return new Date();
  const clean = s.trim();
  if (clean.includes("T")) return new Date(clean);

  // Handle YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY etc.
  const parts = clean.split(/[-/]/).map(Number);
  if (parts.length === 3) {
    // Detect YYYY at start or end
    if (parts[0]! > 1000) return new Date(parts[0]!, parts[1]! - 1, parts[2]!);
    if (parts[2]! > 1000) return new Date(parts[2]!, parts[1]! - 1, parts[0]!);
  }
  return new Date(clean);
}

function scoreDef(query: string, slug: string, name: string): number {
  const q = query.toLowerCase().trim();
  const slugL = slug.toLowerCase();
  const nameL = (name || slug).toLowerCase();
  let s = 0;
  if (!q) return 0;
  if (slugL === q || nameL === q) s += 100;
  if (slugL.includes(q) || nameL.includes(q)) s += 40;
  const qt = tokenize(q);
  const st = new Set(tokenize(slugL + " " + nameL));
  for (const t of qt) {
    if (st.has(t)) s += 12;
    else if (slugL.includes(t) || nameL.includes(t)) s += 6;
  }
  return s;
}

/** Fuzzy match tag definitions by slug/name for the machine (any revision, best row per tagId). */
export async function findTagsFuzzy(machineId: string, query: string, limit = 10): Promise<FindTagCandidate[]> {
  console.log(`[chatTools:findTagsFuzzy] machineId="${machineId}" query="${query}" limit=${limit}`);
  const prisma = getMongoClient();
  const defs = await prisma.tagDefinition.findMany({
    where: { machineId },
    select: { tagId: true, slug: true, name: true, unit: true, machineRevision: true }
  });
  const bestByTag = new Map<string, { tagId: string; slug: string; name: string; unit: string | null; score: number }>();
  for (const d of defs) {
    const sc = scoreDef(query, d.slug, d.name ?? d.slug);
    if (sc <= 0) continue;
    const prev = bestByTag.get(d.tagId);
    if (!prev || sc > prev.score) {
      bestByTag.set(d.tagId, { tagId: d.tagId, slug: d.slug, name: d.name ?? d.slug, unit: d.unit ?? null, score: sc });
    }
  }
  const result = [...bestByTag.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, limit)));
  console.log(`[chatTools:findTagsFuzzy] found ${result.length} candidate(s)`);
  return result;
}

function formatTagLines(
  machineId: string,
  rows: Array<{
    tagId: string;
    valueNumber?: number | null;
    valueBool?: boolean | null;
    valueString?: string | null;
    updatedAt: Date | null;
  }>,
  defMap: Map<string, { slug: string; name: string; unit: string | null }>
): string {
  const lines = rows.map((t) => {
    const val =
      t.valueNumber != null ? t.valueNumber : t.valueBool != null ? String(t.valueBool) : t.valueString ?? "N/A";
    const def = defMap.get(t.tagId);
    const unit = (def?.unit ?? "").trim();
    const slug = def?.slug ?? def?.name ?? t.tagId;
    const iso = t.updatedAt?.toLocaleTimeString?.("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) ?? "N/A";
    const unitSeg = unit ? ` ${unit}` : "";
    return `* ${slug}: ${val}${unitSeg} [${iso}]`;
  });
  return `TELEMETRY SNAPSHOT:\n${lines.join("\n")}`;
}

export async function toolGetTags(machineId: string, args: { tagIds?: string[]; limit?: number }): Promise<string> {
  const limit = Math.min(60, Math.max(1, Number(args.limit ?? 30) || 30));
  const prisma = getMongoClient();
  const tagIds = (args.tagIds ?? []).filter(Boolean).slice(0, 40);

  console.log(`[chatTools:toolGetTags] machineId="${machineId}" tagIds=[${tagIds.join(", ")}] limit=${limit}`);

  const defs = await prisma.tagDefinition.findMany({
    where: { machineId },
    select: { tagId: true, slug: true, name: true, unit: true }
  });
  const defMap = new Map(defs.map((d) => [d.tagId, { slug: d.slug, name: d.name ?? d.slug, unit: d.unit ?? null }]));

  let rows;
  if (tagIds.length > 0) {
    rows = await prisma.tagLatest.findMany({
      where: { machineId, tagId: { in: tagIds } },
      orderBy: { updatedAt: "desc" }
    });
  } else {
    rows = await prisma.tagLatest.findMany({
      where: { machineId },
      orderBy: { updatedAt: "desc" },
      take: limit
    });
  }

  console.log(`[chatTools:toolGetTags] found ${rows.length} row(s)`);

  if (rows.length === 0) return `LIVE TAG VALUES: No tags found for machine "${machineId}".`;
  return formatTagLines(machineId, rows as any[], defMap);
}

export async function toolGetAlerts(
  machineId: string,
  args: { includeRecentClosed?: boolean; from?: string; to?: string }
): Promise<string> {
  const db = getPgDb();

  // Date-range mode: query alerts within a specific window
  const hasDateRange = args.from && !Number.isNaN(Date.parse(args.from));
  if (hasDateRange) {
    const rangeStart = parseLocalDate(args.from!);
    let rangeEnd = args.to ? parseLocalDate(args.to) : new Date(rangeStart.getTime() + 24 * 60 * 60 * 1000);

    // If range is zero-width or negative, expand it to cover the full day
    if (rangeEnd.getTime() <= rangeStart.getTime()) {
      rangeEnd = new Date(rangeStart.getTime() + 24 * 60 * 60 * 1000);
    }

    console.log(`[toolGetAlerts] query machineId="${machineId}" from=${rangeStart.toISOString()} to=${rangeEnd.toISOString()}`);
    const rows = await db
      .select()
      .from(schema.alertEvents)
      .where(
        and(
          eq(schema.alertEvents.machineId, machineId.trim()),
          gte(schema.alertEvents.startsAt, rangeStart),
          lte(schema.alertEvents.startsAt, rangeEnd)
        )
      )
      .orderBy(desc(schema.alertEvents.startsAt))
      .limit(50);

    console.log(`[toolGetAlerts] found ${rows.length} rows`);

    const label = rangeStart.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });
    if (rows.length === 0) {
      return `ALERTS (${label}): No alerts recorded for machine "${machineId}" on this date.`;
    }
    const lines = rows.map(
      (a, i) =>
        `ALERT #${i + 1}: [${String(a.severity).toUpperCase()}] status: ${a.status} | title: "${a.title}" | detected at: ${a.startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}${a.description ? ` | description: ${a.description.slice(0, 120)}` : ""}`
    );
    return `ALERTS ON ${label.toUpperCase()} (${rows.length} total):\n${lines.join("\n")}`;
  }

  // Default mode: open alerts + recent closed
  const includeRecent = args.includeRecentClosed !== false;
  console.log(`[chatTools:toolGetAlerts] machineId="${machineId}" default mode (includeRecent=${includeRecent})`);
  const openRows = await db
    .select()
    .from(schema.alertEvents)
    .where(and(eq(schema.alertEvents.machineId, machineId), eq(schema.alertEvents.status, "open" as any)))
    .orderBy(desc(schema.alertEvents.startsAt))
    .limit(50);

  let recentClosed: typeof openRows = [];
  if (includeRecent) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    recentClosed = await db
      .select()
      .from(schema.alertEvents)
      .where(
        and(
          eq(schema.alertEvents.machineId, machineId),
          ne(schema.alertEvents.status, "open" as any),
          gte(schema.alertEvents.startsAt, since)
        )
      )
      .orderBy(desc(schema.alertEvents.startsAt))
      .limit(30);
  }

  const seen = new Set<string>();
  const merged: typeof openRows = [];
  for (const r of openRows) {
    if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  }
  for (const r of recentClosed) {
    if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  }

  console.log(`[chatTools:toolGetAlerts] found ${merged.length} alert(s) (open=${openRows.length}, recentClosed=${recentClosed.length})`);

  if (merged.length === 0) {
    return `ALERTS: No open or recent (24h) alerts for machine "${machineId}".`;
  }

  const lines = merged.map(
    (a, i) =>
      `ALERT #${i + 1}: [${String(a.severity).toUpperCase()}] status: ${a.status} | title: "${a.title}" | detected at: ${a.startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}${a.description ? ` | description: ${a.description.slice(0, 120)}` : ""}`
  );
  return `ACTIVE ALERTS (${merged.length} total):\n${lines.join("\n")}`;
}

export async function toolGetReports(machineId: string, args: { limit?: number }): Promise<string> {
  const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8) || 8));
  console.log(`[chatTools:toolGetReports] machineId="${machineId}" limit=${limit}`);
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
    .limit(limit);

  console.log(`[chatTools:toolGetReports] found ${runs.length} run(s)`);
  if (runs.length === 0) return `REPORTS: No report runs for machine "${machineId}".`;
  const lines = runs.map(
    (r, i) =>
      `${i + 1}. [${r.status}] id=${r.id} window=${r.windowStart?.toLocaleString?.("en-IN", { timeZone: "Asia/Kolkata" })} → ${r.windowEnd?.toLocaleString?.("en-IN", { timeZone: "Asia/Kolkata" })} metrics=${JSON.stringify(r.metrics)} created=${r.createdAt?.toLocaleString?.("en-IN", { timeZone: "Asia/Kolkata" })}`
  );
  return `REPORTS (last ${runs.length} for "${machineId}"):\n${lines.join("\n")}`;
}

export async function toolGetProductionMetrics(
  machineId: string,
  args: { granularity?: string; buckets?: number; from?: string; to?: string }
): Promise<string> {
  const g = String(args.granularity ?? "daily").toLowerCase();
  const granularity = (g === "weekly" || g === "monthly" ? g : "daily") as ProductionGranularity;
  const buckets = Math.min(90, Math.max(1, Number(args.buckets ?? 14) || 14));
  console.log(`[chatTools:toolGetProductionMetrics] machineId="${machineId}" granularity="${granularity}" buckets=${buckets} from=${args.from} to=${args.to}`);
  const r = await aggregateProductionMetrics({
    machineId,
    granularity,
    buckets,
    fromISO: args.from ?? null,
    toISO: args.to ?? null,
  });
  console.log(`[chatTools:toolGetProductionMetrics] returned ${r.buckets.length} bucket(s)`);
  if (r.buckets.length === 0) {
    return `PRODUCTION METRICS (${granularity}): No production data available for "${machineId}" in the requested window.`;
  }
  const lines = r.buckets.map((b, i) => {
    const prev = i < r.buckets.length - 1 ? r.buckets[i + 1] : null;
    let mDelta = "";
    if (b.runningMeters != null && prev?.runningMeters != null && prev.runningMeters > 0) {
      const pct = Math.round(((b.runningMeters - prev.runningMeters) / prev.runningMeters) * 100);
      mDelta = pct === 0 ? " (flat)" : pct > 0 ? ` (+${pct}%)` : ` (${pct}%)`;
    }
    return `- ${b.label}: meters=${b.runningMeters ?? "n/a"}${mDelta} avgRpm=${b.avgExtruderRpm ?? "n/a"} avgMpm=${b.avgLaminatorMpm ?? "n/a"} avgGsm=${b.avgGsmEntry ?? "n/a"} samples=${b.sampleCount}`;
  });
  const totalMeters = r.buckets.reduce((sum, b) => sum + (b.runningMeters ?? 0), 0);
  const header = `PRODUCTION METRICS (${granularity}, ${r.buckets.length} periods, ${r.from} → ${r.to}, totalMeters=${Math.round(totalMeters)}):`;
  return `${header}\n${lines.join("\n")}`;
}

export type ChatToolName = "find_tags" | "get_tags" | "get_alerts" | "get_reports" | "get_production_metrics";

export type ChatToolCall = { name: ChatToolName; args?: Record<string, unknown> };

export type ToolExecResult = { name: string; text: string; findResult?: FindTagCandidate[] };

export async function executeChatTool(machineId: string, call: ChatToolCall): Promise<ToolExecResult> {
  const args = call.args ?? {};
  console.log(`[chatTools:executeChatTool] name="${call.name}" args=${JSON.stringify(args)}`);
  switch (call.name) {
    case "find_tags": {
      const q = String((args as any).query ?? "");
      const candidates = await findTagsFuzzy(machineId, q, 12);
      if (candidates.length === 0) {
        return { name: call.name, text: `FIND_TAGS: No definitions matched query "${q}" for machine "${machineId}".`, findResult: [] };
      }
      const lines = candidates.map(
        (c, i) => `CANDIDATE #${i + 1}: slug: ${c.slug} | name: ${c.name} | unit: ${c.unit ?? "N/A"}`
      );
      return {
        name: call.name,
        text: `FIND_TAGS (top matches for "${q}"):\n${lines.join("\n")}`,
        findResult: candidates
      };
    }
    case "get_tags": {
      const text = await toolGetTags(machineId, {
        tagIds: Array.isArray((args as any).tagIds) ? ((args as any).tagIds as string[]).map(String) : undefined,
        limit: Number((args as any).limit)
      });
      return { name: call.name, text };
    }
    case "get_alerts": {
      const text = await toolGetAlerts(machineId, {
        includeRecentClosed: (args as any).includeRecentClosed !== false,
        from: (args as any).from ? String((args as any).from) : undefined,
        to: (args as any).to ? String((args as any).to) : undefined,
      });
      return { name: call.name, text };
    }
    case "get_reports": {
      const text = await toolGetReports(machineId, { limit: Number((args as any).limit) });
      return { name: call.name, text };
    }
    case "get_production_metrics": {
      const text = await toolGetProductionMetrics(machineId, {
        granularity: String((args as any).granularity ?? "daily"),
        buckets: Number((args as any).buckets),
        from: (args as any).from ? String((args as any).from) : undefined,
        to: (args as any).to ? String((args as any).to) : undefined,
      });
      return { name: call.name, text };
    }
    default:
      console.warn(`[chatTools:executeChatTool] unknown tool name="${call.name}"`);
      return { name: String(call.name), text: `Unknown tool: ${String((call as any).name)}` };
  }
}

/** Run tools in order; after `find_tags`, auto-fill `get_tags.tagIds` when missing. */
export async function runToolPlan(
  machineId: string,
  calls: ChatToolCall[]
): Promise<{ blocks: { name: string; text: string }[]; findCandidates: FindTagCandidate[] }> {
  console.log(`[chatTools:runToolPlan] machineId="${machineId}" executing ${calls.length} call(s)`);
  const blocks: { name: string; text: string }[] = [];
  let lastFind: FindTagCandidate[] = [];

  for (const raw of calls) {
    const call = { ...raw, args: { ...(raw.args ?? {}) } };
    if (call.name === "get_tags") {
      const hasIds = Array.isArray((call.args as any)?.tagIds) && ((call.args as any).tagIds as unknown[]).length > 0;
      if (!hasIds && lastFind.length > 0) {
        const top = lastFind.filter((c) => c.score >= 8).slice(0, 8);
        if (top.length > 0) {
          console.log(`[chatTools:runToolPlan] auto-filling get_tags.tagIds with ${top.length} candidates from find_tags`);
          (call.args as any).tagIds = top.map((c) => c.tagId);
        }
      }
    }
    const out = await executeChatTool(machineId, call);
    if (out.findResult) lastFind = out.findResult;
    blocks.push({ name: out.name, text: out.text });
  }

  console.log(`[chatTools:runToolPlan] completed ${blocks.length} block(s)`);
  return { blocks, findCandidates: lastFind };
}
