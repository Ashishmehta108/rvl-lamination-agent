import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getPgDb, schema } from "@rvl/db-postgres";
import { and, eq, gte, lt } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { getMongoClient } from "@rvl/db-mongo";
import { config } from "../config.js";
import { Jobs } from "./jobs.js";
import { providerChatOnce } from "../ai/gemini.js";
import {
  getPromptDescriptor,
  REPORT_OVERVIEW_PROMPT_ID,
  REPORT_PRODUCTION_PROMPT_ID,
  REPORT_ALERTS_PROMPT_ID,
  REPORT_TAGS_PROMPT_ID,
  REPORT_TRENDS_PROMPT_ID,
  REPORT_RISKS_PROMPT_ID,
  REPORT_RECOMMENDATIONS_PROMPT_ID,
} from "../services/promptRegistry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportRunPayload = {
  runId?: string;
  scheduleId?: string;
  templateId: string;
  machineId: string;
  windowStart: string;
  windowEnd: string;
};

type TagSnapshotRow = {
  tagId: string;
  name: string;
  slug: string;
  value: number | string | boolean | null;
  unit: string;
  status: "Normal" | "Warn" | "Alarm" | "Fault" | "Stale" | "No Data";
  updatedAt: string;
};

type ChartPoint = { ts: number; v: number };

type TagTrendRow = {
  slug: string;
  name: string;
  unit: string;
  min: number | null;
  max: number | null;
  avg: number | null;
  stdDev: number | null;
  trend: "rising" | "falling" | "stable";
  /** Pre-formatted human-readable string. Pass THIS to LLM steps — never the raw numbers. */
  summary: string;
  sampleCount: number;
  chart: {
    points: ChartPoint[];
    downsampledFrom: number;
    targetPoints: number;
    windowStart: number;
    windowEnd: number;
  };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getReportPrompt(id: string): string {
  const desc = getPromptDescriptor(id);
  if (!desc) throw new Error(`Report prompt not found: ${id}`);
  return desc.systemPrompt;
}

function isTrueValue(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function computeTagStatus(
  slug: string,
  value: unknown,
  warnHigh: number | null,
  warnLow: number | null,
  alarmHigh: number | null,
  alarmLow: number | null,
  isStale: boolean
): TagSnapshotRow["status"] {
  if (isStale) return "Stale";
  if (value === null || value === undefined) return "No Data";
  if (slug.endsWith("_FAULT") && isTrueValue(value)) return "Fault";
  if ((slug === "EMG_STOP" || slug === "ALARM_IND") && isTrueValue(value)) return "Fault";
  if (typeof value === "number") {
    if ((alarmHigh !== null && value >= alarmHigh) || (alarmLow !== null && value <= alarmLow)) return "Alarm";
    if ((warnHigh !== null && value >= warnHigh) || (warnLow !== null && value <= warnLow)) return "Warn";
  }
  return "Normal";
}


/** LTTB (Largest-Triangle-Three-Buckets) downsampling.
 *  Keeps first & last points, selects visually significant points from equal buckets.
 *  Input MUST be sorted by ts ascending. */
function lttbDownsample(data: ChartPoint[], threshold: number): ChartPoint[] {
  if (data.length <= threshold || threshold < 3) return data.slice();
  const out: ChartPoint[] = [data[0]!];
  const bucketSize = (data.length - 2) / (threshold - 2);
  let prevSelected = 0;
  for (let i = 1; i < threshold - 1; i++) {
    const bucketStart = Math.floor((i - 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor(i * bucketSize) + 1, data.length - 1);
    const nextStart = Math.floor(i * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, data.length - 1);
    // Average of next bucket
    let avgTs = 0, avgV = 0, nextCount = 0;
    for (let j = nextStart; j < nextEnd; j++) { avgTs += data[j]!.ts; avgV += data[j]!.v; nextCount++; }
    if (nextCount) { avgTs /= nextCount; avgV /= nextCount; }
    // Pick point in current bucket that forms largest triangle
    let maxArea = -1, bestIdx = bucketStart;
    const pTs = data[prevSelected]!.ts, pV = data[prevSelected]!.v;
    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs((pTs - avgTs) * (data[j]!.v - pV) - (pTs - data[j]!.ts) * (avgV - pV));
      if (area > maxArea) { maxArea = area; bestIdx = j; }
    }
    out.push(data[bestIdx]!);
    prevSelected = bestIdx;
  }
  out.push(data[data.length - 1]!);
  return out;
}

// ─── Data collectors ──────────────────────────────────────────────────────────

async function buildTagSnapshot(machineId: string): Promise<TagSnapshotRow[]> {
  try {
    const prisma = getMongoClient();
    const [tags, defs] = await Promise.all([
      prisma.tagLatest.findMany({ where: { machineId }, orderBy: { updatedAt: "desc" }, take: 60 }),
      prisma.tagDefinition.findMany({
        where: { machineId },
        select: { tagId: true, unit: true, name: true, slug: true, warnHigh: true, warnLow: true, alarmHigh: true, alarmLow: true, staleAfterMs: true }
      })
    ]);
    const defMap = new Map(defs.map((d: any) => [d.tagId, d]));
    const now = Date.now();
    return tags.map((t: any): TagSnapshotRow => {
      const def = defMap.get(t.tagId) as any;
      const value = t.valueNumber ?? (t.valueBool != null ? t.valueBool : t.valueString ?? null);
      const isStale = def?.staleAfterMs ? now - new Date(t.updatedAt).getTime() > def.staleAfterMs : false;
      return {
        tagId: t.tagId,
        name: def?.name ?? t.tagId,
        slug: def?.slug ?? "",
        value,
        unit: def?.unit ?? "",
        status: computeTagStatus(def?.slug ?? "", value, def?.warnHigh ?? null, def?.warnLow ?? null, def?.alarmHigh ?? null, def?.alarmLow ?? null, isStale),
        updatedAt: t.updatedAt?.toISOString?.() ?? ""
      };
    });
  } catch {
    return [];
  }
}

/** Fetch samples for key numeric tags and return compact, LLM-ready trend summaries.
 *
 * Uses Welford's online algorithm for a single-pass O(1)-memory stat computation
 * per tag — no large per-tag number[] arrays are built in memory.
 *
 * Output is intentionally compact: only pre-formatted strings reach the LLM context.
 * Raw samples and intermediate arrays are never serialised into the prompt.
 */
async function buildTrendData(machineId: string, windowStart: Date, windowEnd: Date): Promise<TagTrendRow[]> {
  const TREND_TAGS = [
    "MASTER_SPEED_PCT", "LAMINATOR_MPM", "RUNNING_METER",
    "EXTRUDER_RPM", "WINDER_TENSION", "LAMINATOR_TENSION",
    "EXTRUDER_TEMP_1", "EXTRUDER_TEMP_2"
  ];
  try {
    const prisma = getMongoClient();
    const defs = await prisma.tagDefinition.findMany({
      where: { machineId, slug: { in: TREND_TAGS } },
      select: { tagId: true, slug: true, name: true, unit: true }
    }) as Array<{ tagId: string; slug: string; name: string; unit: string | null }>;

    if (!defs.length) return [];

    // ── Per-tag Welford accumulator ────────────────────────────────────────────
    // pos       — sample index within this tag (0-based), tracked in-struct.
    // earlySum  — sum of first BUCKET samples only.
    // earlyN    — count of early samples (capped at BUCKET).
    // lateBuf   — circular ring buffer of the last BUCKET values seen.
    // lateBufN  — how many slots in lateBuf are valid.
    // lateHead  — write pointer into lateBuf.
    // No pre-count pass needed; no separate tagPos/tagCounts Maps.
    const BUCKET = 334; // ≈ one-third of 1000 samples; keeps memory bounded
    type Acc = {
      n: number; mean: number; M2: number; min: number; max: number;
      pos: number;
      earlySum: number; earlyN: number;
      lateBuf: Float64Array; lateHead: number; lateBufN: number;
      rawPoints: ChartPoint[];
    };
    const acc = new Map<string, Acc>();
    for (const d of defs) {
      acc.set(d.tagId, {
        n: 0, mean: 0, M2: 0, min: Infinity, max: -Infinity,
        pos: 0,
        earlySum: 0, earlyN: 0,
        lateBuf: new Float64Array(BUCKET), lateHead: 0, lateBufN: 0,
        rawPoints: [],
      });
    }

    const samples = await prisma.tagSample.findMany({
      where: {
        machineId,
        tagId: { in: defs.map(d => d.tagId) },
        ts: { gte: windowStart, lte: windowEnd },
        valueNumber: { not: null }
      },
      select: { tagId: true, valueNumber: true, ts: true },
      orderBy: { ts: "asc" },
      take: 10_000
    }) as Array<{ tagId: string; valueNumber: number; ts: Date }>;

    // ── Single pass — no pre-count, no extra Map lookups ──────────────────────
    for (const s of samples) {
      const a = acc.get(s.tagId);
      if (!a) continue;
      const v = s.valueNumber;

      // Welford online mean & variance
      a.n++;
      const delta = v - a.mean;
      a.mean += delta / a.n;
      a.M2 += delta * (v - a.mean);

      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;

      // Early bucket: capture first BUCKET samples inline
      if (a.pos < BUCKET) { a.earlySum += v; a.earlyN++; }

      // Late circular buffer: always write, overwrites oldest slot
      a.lateBuf[a.lateHead] = v;
      a.lateHead = (a.lateHead + 1) % BUCKET;
      if (a.lateBufN < BUCKET) a.lateBufN++;

      // Collect raw point for LTTB charting (bounded by take: 10_000)
      a.rawPoints.push({ ts: s.ts.getTime(), v });

      a.pos++;
    }

    // ── Build LLM-ready output ────────────────────────────────────────────────
    return defs.map(def => {
      const a = acc.get(def.tagId)!;
      if (a.n === 0) return null;

      const avg    = +a.mean.toFixed(2);
      const stdDev = +(Math.sqrt(a.n > 1 ? a.M2 / a.n : 0)).toFixed(2);
      const min    = +a.min.toFixed(2);
      const max    = +a.max.toFixed(2);

      // Late average from the circular buffer
      let lateSum = 0;
      for (let i = 0; i < a.lateBufN; i++) lateSum += a.lateBuf[i]!;
      const earlyAvg = a.earlyN > 0 ? a.earlySum / a.earlyN : avg;
      const lateAvg  = a.lateBufN > 0 ? lateSum / a.lateBufN : avg;

      const trend: "rising" | "falling" | "stable" =
        a.n < 6                       ? "stable"  :
        lateAvg > earlyAvg * 1.05     ? "rising"  :
        lateAvg < earlyAvg * 0.95     ? "falling" : "stable";

      const u = def.unit ? ` ${def.unit}` : "";
      // summary is the ONLY field that reaches the LLM — raw arrays never in prompt
      const summary = `avg ${avg}${u}, min ${min}${u}, max ${max}${u}, stdDev ${stdDev}${u}, trend: ${trend}`;

      const LTTB_TARGET = 80;
      const chartPts = lttbDownsample(a.rawPoints, LTTB_TARGET);

      return {
        slug: def.slug,
        name: def.name,
        unit: def.unit ?? "",
        min, max, avg, stdDev,
        trend,
        summary,
        sampleCount: a.n,
        chart: {
          points: chartPts,
          downsampledFrom: a.n,
          targetPoints: LTTB_TARGET,
          windowStart: windowStart.getTime(),
          windowEnd: windowEnd.getTime(),
        },
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null);
  } catch {
    return [];
  }
}

/** Extract production-relevant tags for the production section. */
function extractProductionFacts(tags: TagSnapshotRow[]) {
  const pick = (slug: string) => tags.find(t => t.slug === slug);
  return {
    runningMeters: pick("RUNNING_METER")?.value ?? null,
    masterSpeedPct: pick("MASTER_SPEED_PCT")?.value ?? null,
    laminatorMpm: pick("LAMINATOR_MPM")?.value ?? null,
    gsm: pick("GSM")?.value ?? null,
    machineRunning: pick("MACHINE_ON_OFF")?.value ?? null,
    extruderOn: pick("EXTRUDER_ON_OFF")?.value ?? null
  };
}

/** Build risk signals from alerts + tag statuses for the risk section. */
function buildRiskSignals(
  alerts: any[],
  tags: TagSnapshotRow[],
  trends: TagTrendRow[]
) {
  const risks: Array<{ type: "alert" | "tag" | "trend"; severity: string; signal: string }> = [];

  // Critical/repeated alerts
  const critAlerts = alerts.filter(a => a.severity === "critical");
  if (critAlerts.length) {
    risks.push({ type: "alert", severity: "critical", signal: `${critAlerts.length} critical alert(s): ${critAlerts.slice(0, 3).map(a => a.title).join("; ")}` });
  }
  const repeated = alerts.filter((a, _, arr) => arr.filter(b => b.title === a.title).length > 2);
  if (repeated.length) {
    risks.push({ type: "alert", severity: "warning", signal: `Repeated alert pattern: "${repeated[0].title}" fired ${alerts.filter(a => a.title === repeated[0].title).length}x` });
  }

  // Fault/alarm tags
  const faultTags = tags.filter(t => t.status === "Fault" || t.status === "Alarm");
  for (const t of faultTags.slice(0, 3)) {
    risks.push({ type: "tag", severity: t.status === "Fault" ? "critical" : "warning", signal: `${t.name} (${t.slug}) is in ${t.status} state — value: ${t.value} ${t.unit}` });
  }

  // Volatile trends (stdDev > 15% of avg)
  const volatileTrends = trends.filter(t => t.avg && t.stdDev && (t.stdDev / t.avg) > 0.15);
  for (const t of volatileTrends.slice(0, 2)) {
    risks.push({ type: "trend", severity: "warning", signal: `${t.name} (${t.slug}) is volatile: avg ${t.avg} ±${t.stdDev} ${t.unit}` });
  }

  return risks.slice(0, 8);
}

// ─── Step runner ──────────────────────────────────────────────────────────────

async function runReportStep(
  stepName: string,
  systemPrompt: string,
  facts: unknown,
  logger: Logger
): Promise<{ html: string; ms: number }> {
  const t0 = Date.now();
  const userMsg = `INPUT_FACTS:\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``;
  try {
    let raw = await providerChatOnce({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg }
      ],
      model: config.aiProvider === "bedrock" ? config.bedrockReportModelId : config.geminiReportModel,
      temperature: config.aiProvider === "bedrock" ? config.bedrockReportTemperature : config.geminiReportTemperature,
      timeoutMs: config.aiProvider === "bedrock" ? config.bedrockReportStepTimeoutMs : config.geminiReportStepTimeoutMs
    });
    raw = raw.trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "");
    logger.info({ stepName, ms: Date.now() - t0 }, "report_step_done");
    return { html: raw, ms: Date.now() - t0 };
  } catch (err: any) {
    logger.warn({ stepName, err: String(err) }, "report_step_failed");
    return {
      html: `<p class="muted"><em>Section unavailable — ${stepName} step failed. Data may be incomplete.</em></p>`,
      ms: Date.now() - t0
    };
  }
}

// ─── Worker registration ──────────────────────────────────────────────────────

export async function registerReportRunner(boss: PgBoss, logger: Logger) {
  logger.info({ job: Jobs.reportRun }, "report_runner_registered");

  await boss.work<ReportRunPayload>(Jobs.reportRun, { teamConcurrency: 2 } as any, async (jobs: any) => {
    for (const job of jobs) {
      const db = getPgDb();
      const payload = job.data as ReportRunPayload;
      const runId = payload.runId ?? newId("run");
      const runLog = (logger as any).child
        ? (logger as any).child({ runId, machineId: payload.machineId, scheduleId: payload.scheduleId ?? null })
        : logger;
      runLog.info({ jobId: job.id }, "report_run_starting");

      const tStart = Date.now();
      const windowStart = new Date(payload.windowStart);
      const windowEnd = new Date(payload.windowEnd);

      // Upsert run record
      await db.insert(schema.reportRuns).values({
        id: runId,
        scheduleId: payload.scheduleId ?? null,
        templateId: payload.templateId,
        machineId: payload.machineId,
        status: "running",
        windowStart,
        windowEnd,
        startedAt: new Date(),
        metrics: {}
      }).onConflictDoUpdate({
        target: schema.reportRuns.id,
        set: { status: "running", startedAt: new Date() }
      });

      try {
        // ── 1. Collect all data upfront ──────────────────────────────────────
        runLog.info("collecting report data");

        const [alerts, tagSnapshot, trendData] = await Promise.all([
          db.select().from(schema.alertEvents).where(
            and(
              eq(schema.alertEvents.machineId, payload.machineId),
              gte(schema.alertEvents.startsAt, windowStart),
              lt(schema.alertEvents.startsAt, windowEnd)
            )
          ).limit(200),
          buildTagSnapshot(payload.machineId),
          buildTrendData(payload.machineId, windowStart, windowEnd)
        ]);

        const productionFacts = extractProductionFacts(tagSnapshot);
        const riskSignals = buildRiskSignals(alerts, tagSnapshot, trendData);

        const alertFacts = alerts.slice(0, 80).map(a => ({
          severity: a.severity,
          status: a.status,
          title: a.title,
          description: a.description,
          startsAt: a.startsAt.toISOString(),
          endsAt: a.endsAt?.toISOString() ?? null,
          durationMinutes: Math.round(((a.endsAt ?? new Date()).getTime() - a.startsAt.getTime()) / 60_000)
        }));

        const tagFacts = tagSnapshot.map(t => ({
          slug: t.slug,
          name: t.name,
          value: t.value,
          unit: t.unit,
          status: t.status,
          updatedAt: t.updatedAt
        }));

        runLog.info({ alertCount: alerts.length, tagCount: tagSnapshot.length, trendCount: trendData.length }, "data_collected");

        // ── 2. Run 7 LLM steps ───────────────────────────────────────────────
        const stepTimings: Record<string, number> = {};

        const overviewFacts = {
          machineId: payload.machineId,
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
          totalAlerts: alerts.length,
          criticalAlerts: alerts.filter(a => a.severity === "critical").length,
          warningAlerts: alerts.filter(a => a.severity === "warning").length,
          riskCount: riskSignals.length,
          machineRunning: productionFacts.machineRunning,
          runningMeters: productionFacts.runningMeters
        };

        runLog.info("step 1/7: overview");
        const s1 = await runReportStep("overview", getReportPrompt(REPORT_OVERVIEW_PROMPT_ID), overviewFacts, runLog);
        stepTimings.overview = s1.ms;

        runLog.info("step 2/7: production");
        const s2 = await runReportStep("production", getReportPrompt(REPORT_PRODUCTION_PROMPT_ID), {
          ...productionFacts,
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
          trendSummary: trendData.find(t => t.slug === "RUNNING_METER") ?? null
        }, runLog);
        stepTimings.production = s2.ms;

        runLog.info("step 3/7: alerts");
        const s3 = await runReportStep("alerts", getReportPrompt(REPORT_ALERTS_PROMPT_ID), {
          total: alerts.length,
          bySeverity: {
            critical: alerts.filter(a => a.severity === "critical").length,
            warning: alerts.filter(a => a.severity === "warning").length,
            info: alerts.filter(a => a.severity === "info").length
          },
          alerts: alertFacts
        }, runLog);
        stepTimings.alerts = s3.ms;

        runLog.info("step 4/7: tags");
        const s4 = await runReportStep("tags", getReportPrompt(REPORT_TAGS_PROMPT_ID), {
          tags: tagFacts
        }, runLog);
        stepTimings.tags = s4.ms;

        runLog.info("step 5/7: trends");
        const s5 = await runReportStep("trends", getReportPrompt(REPORT_TRENDS_PROMPT_ID), {
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
          // Pass only compact summary strings — never raw numeric arrays to LLM
          trends: trendData.map(t => ({ slug: t.slug, name: t.name, unit: t.unit, summary: t.summary, sampleCount: t.sampleCount }))
        }, runLog);
        stepTimings.trends = s5.ms;

        runLog.info("step 6/7: risks");
        const s6 = await runReportStep("risks", getReportPrompt(REPORT_RISKS_PROMPT_ID), {
          risks: riskSignals,
          criticalAlerts: alertFacts.filter(a => a.severity === "critical"),
          faultTags: tagFacts.filter(t => t.status === "Fault" || t.status === "Alarm")
        }, runLog);
        stepTimings.risks = s6.ms;

        runLog.info("step 7/7: recommendations");
        const s7 = await runReportStep("recommendations", getReportPrompt(REPORT_RECOMMENDATIONS_PROMPT_ID), {
          risks: riskSignals,
          criticalAlerts: alertFacts.filter(a => a.severity === "critical").slice(0, 5),
          // Volatile = stdDev > 15% of avg — pass only slug + summary, not raw stats
          volatileTags: trendData
            .filter(t => t.avg && t.stdDev && (t.stdDev / t.avg) > 0.15)
            .map(t => ({ slug: t.slug, name: t.name, summary: t.summary })),
          faultTags: tagFacts.filter(t => t.status === "Fault" || t.status === "Alarm")
        }, runLog);
        stepTimings.recommendations = s7.ms;

        stepTimings.total = Date.now() - tStart;

        // ── 3. Assemble HTML ─────────────────────────────────────────────────
        const narrativeHtml = [
          { label: "Overview", html: s1.html },
          { label: "Production Performance", html: s2.html },
          { label: "Alert Analysis", html: s3.html },
          { label: "Tag Readings", html: s4.html },
          { label: "Trend Analysis", html: s5.html },
          { label: "Risk Detection", html: s6.html },
          { label: "Recommendations", html: s7.html }
        ].map(({ label, html }) =>
          `<div class="report-card"><h3>${label}</h3>${html}</div>`
        ).join("\n");

        const html = renderHtmlReport({
          machineId: payload.machineId,
          windowStart,
          windowEnd,
          alerts: alertFacts.slice(0, 50),
          narrativeHtml,
          buildTimeSeconds: (stepTimings.total / 1000).toFixed(1),
          stepTimings,
          tagTrends: trendData
        });

        // ── 4. Persist artifact ──────────────────────────────────────────────
        const artifactsPath = path.resolve(process.cwd(), config.artifactsDir);
        await fs.mkdir(artifactsPath, { recursive: true });
        const fileName = `report_${payload.machineId}_${runId}.html`;
        const filePath = path.resolve(artifactsPath, fileName);
        await fs.writeFile(filePath, html, "utf8");

        const checksum = crypto.createHash("sha256").update(html).digest("hex");
        const artifactId = newId("artifact");

        await db.insert(schema.reportArtifacts).values({
          id: artifactId,
          runId,
          type: "html",
          uri: filePath,
          checksum,
          bytes: Buffer.byteLength(html, "utf8")
        });

        await db.update(schema.reportRuns).set({
          status: "succeeded",
          finishedAt: new Date(),
          metrics: { stepTimings, totalAlerts: alerts.length, tagCount: tagSnapshot.length, trendCount: trendData.length } as any
        }).where(eq(schema.reportRuns.id, runId));

        runLog.info({ totalMs: stepTimings.total }, "report_run_succeeded");

        if (config.reportEmailTo.length > 0) {
          await boss.send(Jobs.reportEmail, { runId });
        }

      } catch (err: any) {
        runLog.error({ err: String(err) }, "report_runner_failed");
        await db.update(schema.reportRuns).set({
          status: "failed",
          finishedAt: new Date(),
          error: String(err?.message ?? err)
        }).where(eq(schema.reportRuns.id, runId));
        throw err;
      }
    }
  });
}

// ─── HTML renderer ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderHtmlReport(args: {
  machineId: string;
  windowStart: Date;
  windowEnd: Date;
  alerts: any[];
  narrativeHtml: string;
  buildTimeSeconds: string;
  stepTimings: Record<string, number>;
  tagTrends: TagTrendRow[];
}) {
  const fmtIST = (d: Date) =>
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(d);

  const alertRows = args.alerts.map(a => {
    const sev = (a.severity || "info").toLowerCase();
    const color = sev === "critical" ? "#dc2626" : sev === "warning" ? "#d97706" : "#2563eb";
    const bg = sev === "critical" ? "#fef2f2" : sev === "warning" ? "#fffbeb" : "#eff6ff";
    return `<tr>
      <td><span style="display:inline-block;background:${bg};color:${color};font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.04em">${esc(sev.toUpperCase())}</span></td>
      <td>${esc(a.title)}</td>
      <td class="muted">${esc(a.startsAt)}</td>
      <td class="muted">${a.durationMinutes != null ? `${a.durationMinutes}m` : "—"}</td>
    </tr>`;
  }).join("");

  const chipColors: Record<string, string> = {
    overview: "#9e5a32", production: "#16a34a", alerts: "#dc2626",
    tags: "#7c3aed", trends: "#0284c7", risks: "#ea580c", recommendations: "#059669"
  };

  const timingChips = Object.entries(args.stepTimings)
    .filter(([k]) => k !== "total")
    .map(([k, ms]) => {
      const c = chipColors[k] ?? "#9e5a32";
      return `<span style="display:inline-flex;align-items:center;gap:5px;background:#f1efeb;border:1px solid #e5e2dd;border-radius:6px;padding:4px 10px;font-size:11px;color:#6b6964">
        <span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block;flex-shrink:0"></span>
        ${esc(k)}: ${ms}ms
      </span>`;
    }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Production Report - ${esc(args.machineId)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      --bg: #f5f7f8;
      --paper: #ffffff;
      --ink: #182029;
      --text: #303942;
      --muted: #66717d;
      --soft: #eef2f4;
      --line: #dfe6ea;
      --line-strong: #cad4da;
      --accent: #0f766e;
      --accent-soft: #dff3ef;
      --warn: #b45309;
      --warn-soft: #f8ead5;
      --danger: #b42318;
      --danger-soft: #f8d9d6;
      --rise: #0f766e;
      --fall: #b42318;
      --stable: #52616f;
      --shadow: 0 10px 28px rgba(24, 32, 41, .08);
    }
    html { background: var(--bg); }
    body {
      margin: 0;
      background:
        linear-gradient(180deg, #eaf1f3 0, rgba(234, 241, 243, 0) 260px),
        var(--bg);
      color: var(--text);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 56px;
    }
    .report-shell {
      background: var(--paper);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    .masthead {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: start;
      padding: 28px 32px 24px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(90deg, rgba(15, 118, 110, .08), rgba(180, 83, 9, .06)),
        #fff;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 7px;
    }
    h1 {
      margin: 0;
      color: var(--ink);
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    .subhead {
      margin-top: 8px;
      color: var(--muted);
      max-width: 680px;
    }
    .status-badge {
      min-width: 168px;
      border: 1px solid rgba(15, 118, 110, .22);
      background: rgba(223, 243, 239, .8);
      color: #124d49;
      padding: 12px 14px;
      text-align: right;
    }
    .status-badge strong {
      display: block;
      color: var(--ink);
      font-size: 18px;
      line-height: 1.1;
      margin-top: 4px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border-bottom: 1px solid var(--line);
      background: #fbfcfc;
    }
    .meta-item {
      padding: 14px 18px;
      border-right: 1px solid var(--line);
      min-width: 0;
    }
    .meta-item:last-child { border-right: 0; }
    .label {
      color: var(--muted);
      display: block;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: .07em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .value {
      color: var(--ink);
      font-size: 13px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .section {
      padding: 26px 32px;
      border-bottom: 1px solid var(--line);
    }
    .section:last-child { border-bottom: 0; }
    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: end;
      margin-bottom: 16px;
    }
    h2 {
      margin: 0;
      color: var(--ink);
      font-size: 16px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    .section-note {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .metric {
      border: 1px solid var(--line);
      background: #fbfcfc;
      padding: 14px;
      min-width: 0;
    }
    .metric-value {
      color: var(--ink);
      display: flex;
      align-items: baseline;
      gap: 5px;
      font-size: 22px;
      font-weight: 800;
      line-height: 1.1;
      margin-top: 5px;
    }
    .metric-unit {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }
    .trend-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .trend-card {
      border: 1px solid var(--line);
      background: #fff;
      min-width: 0;
    }
    .trend-card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 14px 10px;
    }
    .tag-name {
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .tag-slug {
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
      margin-top: 3px;
      overflow-wrap: anywhere;
    }
    .trend-pill {
      align-self: start;
      border: 1px solid var(--line-strong);
      color: var(--stable);
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: .06em;
      line-height: 1;
      padding: 6px 8px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .trend-pill.rising { color: var(--rise); background: var(--accent-soft); border-color: rgba(15, 118, 110, .22); }
    .trend-pill.falling { color: var(--fall); background: var(--danger-soft); border-color: rgba(180, 35, 24, .22); }
    .trend-pill.stable { color: var(--stable); background: var(--soft); }
    .chart-wrap {
      height: 168px;
      padding: 0 14px 10px;
    }
    .sparkline {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .chart-line {
      fill: none;
      stroke: var(--accent);
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 2.4;
    }
    .axis-line { stroke: #d9e1e5; stroke-width: 1; }
    .axis-label {
      fill: var(--muted);
      font-size: 10px;
      font-weight: 600;
    }
    .trend-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border-top: 1px solid var(--line);
      background: #fbfcfc;
    }
    .trend-stat {
      padding: 10px 12px;
      border-right: 1px solid var(--line);
      min-width: 0;
    }
    .trend-stat:last-child { border-right: 0; }
    .trend-stat strong {
      color: var(--ink);
      display: block;
      font-size: 13px;
      margin-top: 2px;
      overflow-wrap: anywhere;
    }
    .daily-summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .daily-panel {
      border: 1px solid var(--line);
      background: #fff;
      min-width: 0;
      padding: 14px;
    }
    .daily-panel.full { grid-column: 1 / -1; }
    .daily-panel.muted-panel { background: #fbfcfc; }
    .daily-panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
      margin-bottom: 10px;
    }
    .daily-title {
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
      line-height: 1.25;
    }
    .info-dot {
      align-items: center;
      background: var(--soft);
      border: 1px solid var(--line);
      border-radius: 50%;
      color: var(--muted);
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 800;
      height: 22px;
      justify-content: center;
      width: 22px;
    }
    .daily-chart {
      display: block;
      height: 240px;
      overflow: visible;
      width: 100%;
    }
    .daily-chart.compact { height: 150px; }
    .bar-meter { fill: var(--accent); }
    .bar-gsm { fill: var(--warn); }
    .bar-width { fill: #92a2ad; }
    .bar-bg { fill: #edf2f4; }
    .mode-gsm { fill: var(--accent); }
    .mode-gram { fill: var(--warn); }
    .mode-mixed { fill: #8a96a3; }
    .bar-label {
      fill: var(--ink);
      font-size: 10px;
      font-weight: 800;
    }
    .roll-pill {
      fill: #fff;
      stroke: var(--line-strong);
      stroke-width: 1;
    }
    .roll-pill-text {
      fill: var(--text);
      font-size: 9px;
      font-weight: 800;
    }
    .chart-footnote {
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
      margin-top: 10px;
      padding-top: 9px;
    }
    .legend-row {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
    }
    .legend-item {
      align-items: center;
      color: var(--muted);
      display: inline-flex;
      font-size: 11px;
      font-weight: 700;
      gap: 5px;
    }
    .legend-swatch {
      display: inline-block;
      height: 9px;
      width: 9px;
    }
    .legend-swatch.mode-gsm { background: var(--accent); }
    .legend-swatch.mode-gram { background: var(--warn); }
    .legend-swatch.mode-mixed { background: #8a96a3; }
    .empty-state {
      border: 1px dashed var(--line-strong);
      background: #fbfcfc;
      color: var(--muted);
      padding: 22px;
      text-align: center;
    }
    .narrative {
      color: var(--text);
    }
    .narrative h3,
    .report-card h3 {
      margin: 0 0 12px;
      color: var(--ink);
      font-size: 14px;
      line-height: 1.3;
    }
    .narrative h4,
    .report-card h4 {
      color: var(--ink);
      font-size: 13px;
      margin: 16px 0 6px;
    }
    .narrative p,
    .report-card p { margin: 0 0 10px; }
    .narrative ul,
    .report-card ul { margin: 8px 0 12px 20px; padding: 0; }
    .narrative li,
    .report-card li { margin: 0 0 6px; }
    .narrative strong,
    .report-card strong { color: var(--ink); }
    .report-card {
      border: 1px solid var(--line);
      background: #fff;
      padding: 18px;
      margin-bottom: 14px;
    }
    .report-card:last-child { margin-bottom: 0; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th {
      background: #f4f7f8;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: .07em;
      padding: 9px 10px;
      text-align: left;
      text-transform: uppercase;
    }
    td {
      border-bottom: 1px solid var(--soft);
      color: var(--text);
      padding: 10px;
      vertical-align: top;
    }
    tr:last-child td { border-bottom: 0; }
    .muted { color: var(--muted); }
    .timing-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .timing-list > * {
      border: 1px solid var(--line);
      background: #fbfcfc;
      color: var(--text);
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 32px;
      color: var(--muted);
      font-size: 11.5px;
      background: #fbfcfc;
      border-top: 1px solid var(--line);
    }
    @media (max-width: 860px) {
      .page { width: min(100% - 20px, 1120px); padding-top: 10px; }
      .masthead,
      .section-head,
      .footer {
        display: block;
      }
      .status-badge {
        margin-top: 16px;
        text-align: left;
      }
      .meta-grid,
      .metric-grid,
      .daily-summary-grid,
      .trend-grid {
        grid-template-columns: 1fr;
      }
      .meta-item,
      .meta-item:last-child {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .meta-item:last-child { border-bottom: 0; }
      .section,
      .masthead,
      .footer { padding-left: 18px; padding-right: 18px; }
      .trend-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .trend-stat:nth-child(2) { border-right: 0; }
      .trend-stat:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
    }
    @media print {
      html, body { background: #fff; }
      .page { width: 100%; padding: 0; }
      .report-shell { border: 0; box-shadow: none; }
      .trend-card,
      .report-card,
      table { break-inside: avoid; }
      .section { padding: 18px 0; }
      .masthead,
      .footer { padding-left: 0; padding-right: 0; }
    }
  </style>
</head>
<body>
  <div class="page">
    <main class="report-shell">
      <header class="masthead">
        <div>
          <div class="eyebrow">RVL Lamination Monitoring System</div>
          <h1>Production Report</h1>
          <div class="subhead">Machine-level trend, alert, and build-performance summary for ${esc(args.machineId)}.</div>
        </div>
        <div class="status-badge">
          Report Window
          <strong>${fmtIST(args.windowStart)}</strong>
          <span class="muted">to ${fmtIST(args.windowEnd)}</span>
        </div>
      </header>

      <section class="meta-grid" aria-label="Report metadata">
        <div class="meta-item">
          <span class="label">Machine</span>
          <span class="value">${esc(args.machineId)}</span>
        </div>
        <div class="meta-item">
          <span class="label">Window Start</span>
          <span class="value">${fmtIST(args.windowStart)}</span>
        </div>
        <div class="meta-item">
          <span class="label">Window End</span>
          <span class="value">${fmtIST(args.windowEnd)}</span>
        </div>
        <div class="meta-item">
          <span class="label">Build Time</span>
          <span class="value">${args.buildTimeSeconds}s</span>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Tag Trend Charts</h2>
            <div class="section-note">LTTB-downsampled charts preserve the visually significant movement from the raw sample stream.</div>
          </div>
        </div>
        <div id="trendGrid" class="trend-grid"></div>
        <div id="trendEmpty" class="empty-state" hidden>No trend chart data was included for this report window.</div>
      </section>

      <section class="section" id="dailyProductionSection">
        <div class="section-head">
          <div>
            <h2>Daily Production Summary</h2>
            <div class="section-note">Daily output, GSM target, control mode, and fabric-width context derived from tag trend chart points.</div>
          </div>
        </div>
        <div id="dailyProductionGrid" class="daily-summary-grid"></div>
        <div id="dailyProductionEmpty" class="empty-state" hidden>No meter tag data was included for this report window.</div>
      </section>

      <section class="section narrative">
        <div class="section-head">
          <div>
            <h2>Operational Narrative</h2>
            <div class="section-note">Generated analysis and recommended operator attention points.</div>
          </div>
        </div>
        ${args.narrativeHtml}
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Alert Log</h2>
            <div class="section-note">Events detected inside the selected machine window.</div>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Title</th>
              <th>Time (IST)</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>${alertRows || '<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">No alerts in this window</td></tr>'}</tbody>
        </table>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Build Performance</h2>
            <div class="section-note">Report generation timing and model execution details.</div>
          </div>
        </div>
        <div class="timing-list">
          ${timingChips}
        </div>
      </section>

      <footer class="footer">
        <span>RVL Lamination Agent</span>
        <span>Generated by <strong>${config.aiProvider === "bedrock" ? config.bedrockReportModelId : config.geminiReportModel}</strong></span>
      </footer>
    </main>
  </div>

  <script id="trend-data" type="application/json">${JSON.stringify(args.tagTrends).replace(/</g, "\\u003c")}</script>
  <script>
    (function () {
      var seedTrends = [];

      var trendDataNode = document.getElementById("trend-data");
      var injectedTrends = [];
      try {
        injectedTrends = JSON.parse((trendDataNode && trendDataNode.textContent || "").trim());
      } catch (error) {
        injectedTrends = [];
      }
      var trends = injectedTrends && injectedTrends.length ? injectedTrends : seedTrends;
      var grid = document.getElementById("trendGrid");
      var empty = document.getElementById("trendEmpty");

      function numberFmt(value, digits) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
        return Number(value).toLocaleString("en-IN", {
          maximumFractionDigits: digits === undefined ? 2 : digits
        });
      }

      function timeFmt(value) {
        if (!value) return "";
        return new Date(value).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        });
      }

      function escText(value) {
        return String(value === undefined || value === null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

      function normSlug(value) {
        return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      }

      function findTag(slugs) {
        var wanted = slugs.map(normSlug);
        return trends.find(function (tag) { return wanted.indexOf(normSlug(tag.slug)) >= 0; });
      }

      function chartPoints(tag) {
        return ((tag && tag.chart && tag.chart.points) || [])
          .filter(function (point) {
            return point && Number.isFinite(Number(point.ts)) && Number.isFinite(Number(point.v));
          })
          .map(function (point) {
            return { ts: Number(point.ts), v: Number(point.v) };
          })
          .sort(function (a, b) { return a.ts - b.ts; });
      }

      function dayKey(ts) {
        var parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).formatToParts(new Date(ts));
        var out = {};
        parts.forEach(function (part) { out[part.type] = part.value; });
        return out.year + "-" + out.month + "-" + out.day;
      }

      function dayLabel(key) {
        var parts = key.split("-");
        var date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
        return date.toLocaleDateString("en-IN", {
          timeZone: "UTC",
          day: "2-digit",
          month: "short"
        });
      }

      function groupByDay(points) {
        return points.reduce(function (acc, point) {
          var key = dayKey(point.ts);
          if (!acc[key]) acc[key] = [];
          acc[key].push(point);
          return acc;
        }, {});
      }

      function avg(points) {
        if (!points.length) return 0;
        return points.reduce(function (sum, point) { return sum + point.v; }, 0) / points.length;
      }

      function titleBlock(title, tag) {
        var description = tag && tag.description ? tag.description : "";
        return '' +
          '<div class="daily-panel-head">' +
            '<div>' +
              '<div class="daily-title">' + escText(title) + '</div>' +
              (description ? '<div class="section-note">' + escText(description) + '</div>' : '') +
            '</div>' +
            (description ? '<span class="info-dot" title="' + escText(description) + '">i</span>' : '') +
          '</div>';
      }

      function deriveDailyProduction() {
        var totalMeter = findTag(["TOTAL_METER", "TOTAL METER", "TOTALMETER"]);
        var runningMeter = findTag(["RUNNING_METER", "RUNNING METER", "RUNNINGMETER"]);
        var meterTag = totalMeter || runningMeter;
        var meterPoints = chartPoints(meterTag);
        if (!meterTag || !meterPoints.length) return null;

        var meterGroups = groupByDay(meterPoints);
        var days = Object.keys(meterGroups).sort();
        var rows = days.map(function (key) {
          var points = meterGroups[key];
          var values = points.map(function (point) { return point.v; });
          return {
            key: key,
            label: dayLabel(key),
            meters: Math.max(0, Math.max.apply(Math, values) - Math.min.apply(Math, values)),
            rolls: 0,
            gsm: null,
            width: null,
            gsmPct: 0,
            gramPct: 0,
            mixedPct: 100,
            dominantGsm: null
          };
        });

        var rowByKey = rows.reduce(function (acc, row) {
          acc[row.key] = row;
          return acc;
        }, {});

        if (runningMeter) {
          var previous = null;
          chartPoints(runningMeter).forEach(function (point) {
            if (previous && previous.v > 0 && point.v < previous.v * 0.5) {
              var key = dayKey(point.ts);
              if (rowByKey[key]) rowByKey[key].rolls += 1;
            }
            previous = point;
          });
        }

        var gsmEntry = findTag(["GSM_ENTRY", "GSM ENTRY", "GSM"]);
        if (gsmEntry) {
          var gsmGroups = groupByDay(chartPoints(gsmEntry));
          Object.keys(gsmGroups).forEach(function (key) {
            if (rowByKey[key]) {
              rowByKey[key].gsm = avg(gsmGroups[key]);
              rowByKey[key].dominantGsm = rowByKey[key].gsm;
            }
          });
        }

        var gsmMode = findTag(["GSM_MODE_ACTIVE", "GSM MODE ACTIVE"]);
        var gramMode = findTag(["GRAM_LOGIC_MODE_ACTIVE", "GRAM LOGIC MODE ACTIVE", "GRAM_MODE_ACTIVE"]);
        if (gsmMode || gramMode) {
          days.forEach(function (key) {
            var gsmPoints = gsmMode ? (groupByDay(chartPoints(gsmMode))[key] || []) : [];
            var gramPoints = gramMode ? (groupByDay(chartPoints(gramMode))[key] || []) : [];
            var sampleTotal = Math.max(gsmPoints.length, gramPoints.length, 1);
            var gsmActive = gsmPoints.filter(function (point) { return point.v >= 0.5; }).length;
            var gramActive = gramPoints.filter(function (point) { return point.v >= 0.5; }).length;
            var gsmPct = Math.round((gsmActive / sampleTotal) * 100);
            var gramPct = Math.round((gramActive / sampleTotal) * 100);
            var row = rowByKey[key];
            if (!row) return;
            row.gsmPct = gsmPct > 80 ? gsmPct : Math.min(gsmPct, 80);
            row.gramPct = gramPct > 80 ? gramPct : Math.min(gramPct, 80);
            row.mixedPct = Math.max(0, 100 - row.gsmPct - row.gramPct);
            if (gsmPct > 80) {
              row.gsmPct = 100;
              row.gramPct = 0;
              row.mixedPct = 0;
            } else if (gramPct > 80) {
              row.gsmPct = 0;
              row.gramPct = 100;
              row.mixedPct = 0;
            }
          });
        }

        var fabricWidth = findTag(["FABRIC_WIDTH", "FABRIC WIDTH"]);
        if (fabricWidth) {
          var widthGroups = groupByDay(chartPoints(fabricWidth));
          Object.keys(widthGroups).forEach(function (key) {
            if (rowByKey[key]) rowByKey[key].width = avg(widthGroups[key]);
          });
        }

        return {
          rows: rows,
          meterTag: meterTag,
          usedFallback: !totalMeter && !!runningMeter,
          runningMeter: runningMeter,
          gsmEntry: gsmEntry,
          gsmMode: gsmMode,
          gramMode: gramMode,
          fabricWidth: fabricWidth
        };
      }

      function renderBarChart(rows, valueKey, options) {
        var width = 620;
        var height = options.height || 230;
        var pad = { top: 32, right: 18, bottom: 38, left: 58 };
        var values = rows.map(function (row) { return Number(row[valueKey] || 0); });
        var maxValue = Math.max(1, Math.max.apply(Math, values) * 1.16);
        var innerWidth = width - pad.left - pad.right;
        var innerHeight = height - pad.top - pad.bottom;
        var slot = innerWidth / Math.max(1, rows.length);
        var barWidth = Math.max(18, Math.min(options.barWidth || 34, slot * 0.58));

        var bars = rows.map(function (row, index) {
          var value = Number(row[valueKey] || 0);
          var barHeight = (value / maxValue) * innerHeight;
          var x = pad.left + index * slot + (slot - barWidth) / 2;
          var y = pad.top + innerHeight - barHeight;
          var rollText = row.rolls ? row.rolls + " rolls" : "";
          var tooltip = row.label + ": " + numberFmt(value, 0) + " " + options.unit +
            (row.rolls ? ", " + rollText : "") +
            (row.dominantGsm ? ", GSM " + numberFmt(row.dominantGsm, 1) : "");
          return '' +
            '<g>' +
              '<title>' + escText(tooltip) + '</title>' +
              '<rect class="' + escText(options.className) + '" x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + barHeight.toFixed(2) + '"></rect>' +
              '<text class="bar-label" text-anchor="middle" x="' + (x + barWidth / 2).toFixed(2) + '" y="' + Math.max(12, y - 6).toFixed(2) + '">' + escText(numberFmt(value, options.digits || 0)) + (options.suffix || "") + '</text>' +
              (rollText ? '<rect class="roll-pill" x="' + (x + barWidth / 2 - 24).toFixed(2) + '" y="' + Math.max(2, y - 28).toFixed(2) + '" width="48" height="16" rx="8"></rect><text class="roll-pill-text" text-anchor="middle" x="' + (x + barWidth / 2).toFixed(2) + '" y="' + Math.max(14, y - 17).toFixed(2) + '">' + escText(rollText) + '</text>' : '') +
              '<text class="axis-label" text-anchor="middle" x="' + (x + barWidth / 2).toFixed(2) + '" y="' + (height - 10) + '">' + escText(row.label) + '</text>' +
            '</g>';
        }).join("");

        return '' +
          '<svg class="daily-chart' + (options.compact ? ' compact' : '') + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escText(options.aria) + '">' +
            '<text class="axis-label" x="0" y="16">' + escText(options.yLabel) + '</text>' +
            '<text class="axis-label" text-anchor="end" x="' + (pad.left - 8) + '" y="' + (pad.top + 4) + '">' + escText(numberFmt(maxValue, 0)) + '</text>' +
            '<text class="axis-label" text-anchor="end" x="' + (pad.left - 8) + '" y="' + (pad.top + innerHeight + 4) + '">0</text>' +
            '<line class="axis-line" x1="' + pad.left + '" y1="' + pad.top + '" x2="' + pad.left + '" y2="' + (pad.top + innerHeight) + '"></line>' +
            '<line class="axis-line" x1="' + pad.left + '" y1="' + (pad.top + innerHeight) + '" x2="' + (width - pad.right) + '" y2="' + (pad.top + innerHeight) + '"></line>' +
            bars +
          '</svg>';
      }

      function renderModeTimeline(summary) {
        var rows = summary.rows;
        var width = 920;
        var rowHeight = 34;
        var pad = { top: 10, right: 20, bottom: 8, left: 86 };
        var height = pad.top + pad.bottom + rows.length * rowHeight;
        var innerWidth = width - pad.left - pad.right;
        var groups = rows.map(function (row, index) {
          var y = pad.top + index * rowHeight + 7;
          var x = pad.left;
          var gsmW = innerWidth * row.gsmPct / 100;
          var gramW = innerWidth * row.gramPct / 100;
          var mixedW = Math.max(0, innerWidth - gsmW - gramW);
          return '' +
            '<g>' +
              '<text class="axis-label" text-anchor="end" x="' + (pad.left - 10) + '" y="' + (y + 13) + '">' + escText(row.label) + '</text>' +
              '<rect class="bar-bg" x="' + x + '" y="' + y + '" width="' + innerWidth + '" height="18"></rect>' +
              '<rect class="mode-gsm" x="' + x + '" y="' + y + '" width="' + gsmW.toFixed(2) + '" height="18"></rect>' +
              '<rect class="mode-gram" x="' + (x + gsmW).toFixed(2) + '" y="' + y + '" width="' + gramW.toFixed(2) + '" height="18"></rect>' +
              '<rect class="mode-mixed" x="' + (x + gsmW + gramW).toFixed(2) + '" y="' + y + '" width="' + mixedW.toFixed(2) + '" height="18"></rect>' +
              '<title>' + escText(row.label + ": GSM " + row.gsmPct + "%, Gram " + row.gramPct + "%, Mixed " + row.mixedPct + "%") + '</title>' +
            '</g>';
        }).join("");
        return '<svg class="daily-chart compact" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Control mode by day">' + groups + '</svg>';
      }

      function renderDailyProduction() {
        var section = document.getElementById("dailyProductionSection");
        var container = document.getElementById("dailyProductionGrid");
        var emptyNode = document.getElementById("dailyProductionEmpty");
        var summary = deriveDailyProduction();
        if (!summary || !summary.rows.length) {
          container.hidden = true;
          emptyNode.hidden = false;
          return;
        }

        var html = '';
        html += '<article class="daily-panel">' +
          titleBlock("Daily Output (meters)", summary.meterTag) +
          renderBarChart(summary.rows, "meters", {
            aria: "Daily output in meters derived from " + (summary.meterTag.name || "meter tag"),
            className: "bar-meter",
            yLabel: "Meters from " + (summary.meterTag.name || "meter tag"),
            unit: "m",
            suffix: " m"
          }) +
          (summary.usedFallback ? '<div class="chart-footnote">Using ' + escText(summary.runningMeter.name) + ' because Total Meter is absent. Roll resets may undercount daily production.</div>' : '') +
          '</article>';

        if (summary.gsmEntry) {
          html += '<article class="daily-panel">' +
            titleBlock("Average GSM Target per Day", summary.gsmEntry) +
            renderBarChart(summary.rows.filter(function (row) { return row.gsm !== null; }), "gsm", {
              aria: "Average GSM target per day from " + summary.gsmEntry.name,
              barWidth: 26,
              className: "bar-gsm",
              digits: 1,
              yLabel: summary.gsmEntry.name + " g/m2",
              unit: "g/m2",
              suffix: ""
            }) +
            '</article>';
        }

        if (summary.gsmMode || summary.gramMode) {
          var modeDescription = "Indicates whether the machine ran in GSM control mode or Gram control mode each day. Mixed days mean the operator switched modes mid-shift.";
          html += '<article class="daily-panel full">' +
            titleBlock("Control Mode by Day", { description: modeDescription }) +
            renderModeTimeline(summary) +
            '<div class="legend-row">' +
              '<span class="legend-item"><span class="legend-swatch mode-gsm"></span>GSM Control Mode</span>' +
              '<span class="legend-item"><span class="legend-swatch mode-gram"></span>Gram Control Mode</span>' +
              '<span class="legend-item"><span class="legend-swatch mode-mixed"></span>Mixed / Transitioning</span>' +
            '</div>' +
            '</article>';
        }

        if (summary.fabricWidth) {
          html += '<article class="daily-panel full muted-panel">' +
            titleBlock("Fabric Width per Day", summary.fabricWidth) +
            renderBarChart(summary.rows.filter(function (row) { return row.width !== null; }), "width", {
              aria: "Fabric width per day from " + summary.fabricWidth.name,
              className: "bar-width",
              compact: true,
              digits: 0,
              height: 150,
              yLabel: summary.fabricWidth.name + " mm",
              unit: "mm",
              suffix: " mm"
            }) +
            '</article>';
        }

        container.innerHTML = html;
        section.hidden = false;
        emptyNode.hidden = true;
      }

      function makePath(points, width, height, pad, yMin, yMax) {
        if (!points.length) return "";
        var xMin = points[0].ts;
        var xMax = points[points.length - 1].ts;
        var xSpan = Math.max(1, xMax - xMin);
        var ySpan = Math.max(1e-9, yMax - yMin);
        return points.map(function (point, index) {
          var x = pad.left + ((point.ts - xMin) / xSpan) * (width - pad.left - pad.right);
          var y = pad.top + (1 - ((point.v - yMin) / ySpan)) * (height - pad.top - pad.bottom);
          return (index ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
        }).join(" ");
      }

      function renderChart(tag, index) {
        var points = ((tag.chart && tag.chart.points) || [])
          .filter(function (point) {
            return point && Number.isFinite(Number(point.ts)) && Number.isFinite(Number(point.v));
          })
          .map(function (point) {
            return { ts: Number(point.ts), v: Number(point.v) };
          })
          .sort(function (a, b) { return a.ts - b.ts; });

        var width = 620;
        var height = 170;
        var pad = { top: 14, right: 10, bottom: 28, left: 46 };
        var values = points.map(function (point) { return point.v; });
        var yMin = values.length ? Math.min.apply(Math, values) : 0;
        var yMax = values.length ? Math.max.apply(Math, values) : 1;
        if (yMin === yMax) {
          yMin = yMin - 1;
          yMax = yMax + 1;
        }
        var path = makePath(points, width, height, pad, yMin, yMax);
        var area = path ? path + " L" + (width - pad.right) + " " + (height - pad.bottom) + " L" + pad.left + " " + (height - pad.bottom) + " Z" : "";
        var start = points.length ? timeFmt(points[0].ts) : "";
        var end = points.length ? timeFmt(points[points.length - 1].ts) : "";
        var gradientId = "areaFill" + index;

        return '' +
          '<svg class="sparkline" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escText(tag.name || tag.slug || "Trend chart") + '">' +
            '<defs>' +
              '<linearGradient id="' + gradientId + '" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#0f766e" stop-opacity=".22"></stop>' +
                '<stop offset="100%" stop-color="#0f766e" stop-opacity="0"></stop>' +
              '</linearGradient>' +
            '</defs>' +
            '<line class="axis-line" x1="' + pad.left + '" y1="' + pad.top + '" x2="' + pad.left + '" y2="' + (height - pad.bottom) + '"></line>' +
            '<line class="axis-line" x1="' + pad.left + '" y1="' + (height - pad.bottom) + '" x2="' + (width - pad.right) + '" y2="' + (height - pad.bottom) + '"></line>' +
            '<text class="axis-label" x="0" y="' + (pad.top + 4) + '">' + escText(numberFmt(yMax)) + '</text>' +
            '<text class="axis-label" x="0" y="' + (height - pad.bottom + 4) + '">' + escText(numberFmt(yMin)) + '</text>' +
            '<text class="axis-label" x="' + pad.left + '" y="' + (height - 6) + '">' + escText(start) + '</text>' +
            '<text class="axis-label" text-anchor="end" x="' + (width - pad.right) + '" y="' + (height - 6) + '">' + escText(end) + '</text>' +
            (area ? '<path d="' + area + '" fill="url(#' + gradientId + ')"></path>' : '') +
            (path ? '<path class="chart-line" d="' + path + '"></path>' : '') +
          '</svg>';
      }

      function renderTag(tag, index) {
        var trend = String(tag.trend || "stable").toLowerCase();
        var unit = tag.unit ? " " + escText(tag.unit) : "";
        var points = tag.chart && tag.chart.points ? tag.chart.points.length : 0;
        var sampleCount = tag.sampleCount || (tag.chart && tag.chart.downsampledFrom) || 0;

        return '' +
          '<article class="trend-card">' +
            '<div class="trend-card-header">' +
              '<div>' +
                '<div class="tag-name">' + escText(tag.name || tag.slug || "Unnamed tag") + '</div>' +
                '<div class="tag-slug">' + escText(tag.slug || "") + '</div>' +
              '</div>' +
              '<span class="trend-pill ' + escText(trend) + '">' + escText(trend) + '</span>' +
            '</div>' +
            '<div class="chart-wrap">' + renderChart(tag, index) + '</div>' +
            '<div class="trend-stats">' +
              '<div class="trend-stat"><span class="label">Avg</span><strong>' + escText(numberFmt(tag.avg)) + unit + '</strong></div>' +
              '<div class="trend-stat"><span class="label">Min</span><strong>' + escText(numberFmt(tag.min)) + unit + '</strong></div>' +
              '<div class="trend-stat"><span class="label">Max</span><strong>' + escText(numberFmt(tag.max)) + unit + '</strong></div>' +
              '<div class="trend-stat"><span class="label">Samples</span><strong>' + escText(numberFmt(sampleCount, 0)) + ' -> ' + escText(numberFmt(points, 0)) + '</strong></div>' +
            '</div>' +
          '</article>';
      }

      renderDailyProduction();

      if (!trends || !trends.length) {
        empty.hidden = false;
        grid.hidden = true;
        return;
      }

      grid.innerHTML = trends.map(renderTag).join("");
    }());
  </script>
</body>
</html>`;
}


// function renderHtmlReport(args: {
//   machineId: string;
//   windowStart: Date;
//   windowEnd: Date;
//   alerts: any[];
//   narrativeHtml: string;
//   buildTimeSeconds: string;
//   stepTimings: Record<string, number>;
// }) {
//   const fmtIST = (d: Date) =>
//     new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(d);

//   const timingRows = Object.entries(args.stepTimings)
//     .filter(([k]) => k !== "total")
//     .map(([k, ms]) => `<tr><td>${esc(k)}</td><td>${ms}ms</td></tr>`)
//     .join("");

//   const alertRows = args.alerts.map(a => {
//     const sev = (a.severity || "info").toLowerCase();
//     const color = sev === "critical" ? "#ff4d4f" : sev === "warning" ? "#faad14" : "#1890ff";
//     return `<tr>
//       <td style="color:${color};font-weight:bold">${esc(sev.toUpperCase())}</td>
//       <td>${esc(a.title)}</td>
//       <td class="muted">${esc(a.startsAt)}</td>
//       <td class="muted">${a.durationMinutes != null ? `${a.durationMinutes}m` : "—"}</td>
//     </tr>`;
//   }).join("");

//   return `<!doctype html>
// <html lang="en">
// <head>
//   <meta charset="utf-8">
//   <meta name="viewport" content="width=device-width,initial-scale=1">
//   <title>Production Report — ${esc(args.machineId)}</title>
//   <style>
//     *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
//     body { background: #0b0f14; color: #d8dee9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; line-height: 1.6; }
//     h1 { color: #eceff4; font-size: 1.6rem; margin-bottom: 4px; }
//     h2 { color: #88c0d0; font-size: 1.1rem; margin-bottom: 20px; font-weight: 400; }
//     h3 { color: #81a1c1; font-size: 1rem; border-bottom: 1px solid #2e3440; padding-bottom: 8px; margin-bottom: 14px; }
//     h4 { color: #a3be8c; font-size: 0.9rem; margin: 12px 0 6px; }
//     .report-card { background: #141b24; border: 1px solid #1f2a36; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
//     table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
//     th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1f2a36; }
//     th { background: #0f1720; color: #8aa0b6; font-weight: 600; }
//     tr:last-child td { border-bottom: none; }
//     .muted { color: #8aa0b6; font-size: 12px; }
//     ul { padding-left: 20px; }
//     li { margin-bottom: 8px; }
//     p { margin-bottom: 10px; }
//     .timings { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
//     .timing-chip { background: #0f1720; border: 1px solid #1f2a36; border-radius: 6px; padding: 4px 10px; font-size: 11px; color: #8aa0b6; }
//     .footer { margin-top: 40px; border-top: 1px solid #1f2a36; padding-top: 20px; font-size: 11px; color: #4c566a; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
//   </style>
// </head>
// <body>
//   <div style="margin-bottom:32px">
//     <h1>Production Report</h1>
//     <h2>Machine: <strong style="color:#eceff4">${esc(args.machineId)}</strong> &nbsp;|&nbsp; ${fmtIST(args.windowStart)} → ${fmtIST(args.windowEnd)}</h2>
//   </div>

//   ${args.narrativeHtml}

//   <div class="report-card">
//     <h3>Alert Log</h3>
//     <table>
//       <thead><tr><th>Severity</th><th>Title</th><th>Time</th><th>Duration</th></tr></thead>
//       <tbody>${alertRows || '<tr><td colspan="4" class="muted">No alerts in this window</td></tr>'}</tbody>
//     </table>
//   </div>

//   <div class="report-card">
//     <h3>Build Performance</h3>
//     <p class="muted">Total build time: <strong>${args.buildTimeSeconds}s</strong></p>
//     <div class="timings">
//       ${Object.entries(args.stepTimings).filter(([k]) => k !== "total").map(([k, ms]) =>
//         `<span class="timing-chip">${esc(k)}: ${ms}ms</span>`
//       ).join("")}
//     </div>
//   </div>

//   <div class="footer">
//     <span>&copy; RVL Lamination Agent</span>
//     <span>Generated by <strong>${config.aiProvider === "bedrock" ? config.bedrockReportModelId : config.geminiReportModel}</strong> in ${args.buildTimeSeconds}s</span>
//   </div>
// </body>
// </html>`;
// }
