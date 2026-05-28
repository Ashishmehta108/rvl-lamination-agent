import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getPgDb, schema } from "@rvl/db-postgres";
import { and, eq, gte, lt } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { getMongoClient, getNativeDb } from "@rvl/db-mongo";
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

function istDayKey(date: Date): string {
  return new Date(date.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayKeysBetween(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const start = new Date(from.getTime() + 5.5 * 60 * 60 * 1000);
  const end = new Date(to.getTime() + 5.5 * 60 * 60 * 1000);
  
  const curr = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  
  while (curr.getTime() <= endDay.getTime()) {
    keys.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }
  return keys;
}

/** LTTB (Largest-Triangle-Three-Buckets) downsampling. */
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
    let avgTs = 0, avgV = 0, nextCount = 0;
    for (let j = nextStart; j < nextEnd; j++) { avgTs += data[j]!.ts; avgV += data[j]!.v; nextCount++; }
    if (nextCount) { avgTs /= nextCount; avgV /= nextCount; }
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

async function buildTrendData(machineId: string, windowStart: Date, windowEnd: Date): Promise<TagTrendRow[]> {
  const TREND_TAGS = [
    "MASTER_SPEED_PCT", "LAMINATOR_MPM",
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

    const BUCKET = 334;
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

    for (const s of samples) {
      const a = acc.get(s.tagId);
      if (!a) continue;
      const v = s.valueNumber;
      a.n++;
      const delta = v - a.mean;
      a.mean += delta / a.n;
      a.M2 += delta * (v - a.mean);
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
      if (a.pos < BUCKET) { a.earlySum += v; a.earlyN++; }
      a.lateBuf[a.lateHead] = v;
      a.lateHead = (a.lateHead + 1) % BUCKET;
      if (a.lateBufN < BUCKET) a.lateBufN++;
      a.rawPoints.push({ ts: s.ts.getTime(), v });
      a.pos++;
    }

    return defs.map(def => {
      const a = acc.get(def.tagId)!;
      if (a.n === 0) return null;
      const avg = +a.mean.toFixed(2);
      const stdDev = +(Math.sqrt(a.n > 1 ? a.M2 / a.n : 0)).toFixed(2);
      const min = +a.min.toFixed(2);
      const max = +a.max.toFixed(2);
      let lateSum = 0;
      for (let i = 0; i < a.lateBufN; i++) lateSum += a.lateBuf[i]!;
      const earlyAvg = a.earlyN > 0 ? a.earlySum / a.earlyN : avg;
      const lateAvg = a.lateBufN > 0 ? lateSum / a.lateBufN : avg;
      const trend: "rising" | "falling" | "stable" =
        a.n < 6 ? "stable" :
          lateAvg > earlyAvg * 1.05 ? "rising" :
            lateAvg < earlyAvg * 0.95 ? "falling" : "stable";
      const u = def.unit ? ` ${def.unit}` : "";
      const summary = `avg ${avg}${u}, min ${min}${u}, max ${max}${u}, stdDev ${stdDev}${u}, trend: ${trend}`;
      const LTTB_TARGET = 80;
      const chartPts = lttbDownsample(a.rawPoints, LTTB_TARGET);
      return {
        slug: def.slug, name: def.name, unit: def.unit ?? "",
        min, max, avg, stdDev, trend, summary,
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

function extractProductionFacts(tags: TagSnapshotRow[]) {
  const pick = (slug: string) => tags.find(t => t.slug === slug);
  return {
    masterSpeedPct: pick("MASTER_SPEED_PCT")?.value ?? null,
    laminatorMpm: pick("LAMINATOR_MPM")?.value ?? null,
    gsm: pick("GSM")?.value ?? null,
    machineRunning: pick("MACHINE_ON_OFF")?.value ?? null,
    extruderOn: pick("EXTRUDER_ON_OFF")?.value ?? null
  };
}

function buildRiskSignals(
  alerts: any[],
  tags: TagSnapshotRow[],
  trends: TagTrendRow[]
) {
  const risks: Array<{ type: "alert" | "tag" | "trend"; severity: string; signal: string }> = [];
  const critAlerts = alerts.filter(a => a.severity === "critical");
  if (critAlerts.length) {
    risks.push({ type: "alert", severity: "critical", signal: `${critAlerts.length} critical alert(s): ${critAlerts.slice(0, 3).map(a => a.title).join("; ")}` });
  }
  const repeated = alerts.filter((a, _, arr) => arr.filter(b => b.title === a.title).length > 2);
  if (repeated.length) {
    risks.push({ type: "alert", severity: "warning", signal: `Repeated alert pattern: "${repeated[0].title}" fired ${alerts.filter(a => a.title === repeated[0].title).length}x` });
  }
  const faultTags = tags.filter(t => t.status === "Fault" || t.status === "Alarm");
  for (const t of faultTags.slice(0, 3)) {
    risks.push({ type: "tag", severity: t.status === "Fault" ? "critical" : "warning", signal: `${t.name} (${t.slug}) is in ${t.status} state — value: ${t.value} ${t.unit}` });
  }
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
      html: `<p style="color:#6b7280;font-size:12px;font-style:italic;margin:0;">Section unavailable — ${stepName} step failed.</p>`,
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

        // ── Fetch ProductionDaily data from native mongo early ───────────────────
        const nativeDb = await getNativeDb();
        
        // 1. Fetch Today's production
        const todayStr = istDayKey(new Date());
        const prodTodayDoc = await nativeDb.collection<any>("ProductionDaily").findOne({
          _id: `${payload.machineId}:${todayStr}`
        });
        const todayProducedMeters =
          typeof prodTodayDoc?.meters === "number" && Number.isFinite(prodTodayDoc.meters)
            ? Math.round(prodTodayDoc.meters * 10) / 10
            : 0;

        // 2. Fetch daily production records for report window
        const daysInWindow = dayKeysBetween(windowStart, windowEnd);
        const prodDailyDocs = await nativeDb.collection<any>("ProductionDaily")
          .find({
            machineId: payload.machineId,
            day: { $in: daysInWindow }
          })
          .toArray();
        
        const productionDailyMap = new Map(prodDailyDocs.map((doc: any) => [doc.day, doc.meters]));
        const totalMeters = Array.from(productionDailyMap.values()).reduce((sum: number, v: any) => sum + (typeof v === "number" ? v : 0), 0);

        const speedTrend = trendData.find(t => t.slug === "MASTER_SPEED_PCT");
        const speedAvg = speedTrend?.avg ?? null;

        runLog.info({ alertCount: alerts.length, tagCount: tagSnapshot.length, trendCount: trendData.length }, "data_collected");

        const stepTimings: Record<string, number> = {};

        const overviewFacts = {
          machineId: payload.machineId,
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
          totalAlerts: alerts.length,
          criticalAlerts: alerts.filter(a => a.severity === "critical").length,
          warningAlerts: alerts.filter(a => a.severity === "warning").length,
          riskCount: riskSignals.length,
          machineRunning: productionFacts.machineRunning
        };

        runLog.info("step 1/7: overview");
        const s1 = await runReportStep("overview", getReportPrompt(REPORT_OVERVIEW_PROMPT_ID), overviewFacts, runLog);
        stepTimings.overview = s1.ms;

        runLog.info("step 2/7: production");
        const s2 = await runReportStep("production", getReportPrompt(REPORT_PRODUCTION_PROMPT_ID), {
          ...productionFacts,
          todayProducedMeters,
          totalMetersProduced: Math.round(totalMeters * 10) / 10,
          lineEfficiency: speedAvg !== null ? Math.round(speedAvg * 10) / 10 : null,
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd
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
        const s4 = await runReportStep("tags", getReportPrompt(REPORT_TAGS_PROMPT_ID), { tags: tagFacts }, runLog);
        stepTimings.tags = s4.ms;

        runLog.info("step 5/7: trends");
        const s5 = await runReportStep("trends", getReportPrompt(REPORT_TRENDS_PROMPT_ID), {
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
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
          volatileTags: trendData
            .filter(t => t.avg && t.stdDev && (t.stdDev / t.avg) > 0.15)
            .map(t => ({ slug: t.slug, name: t.name, summary: t.summary })),
          faultTags: tagFacts.filter(t => t.status === "Fault" || t.status === "Alarm")
        }, runLog);
        stepTimings.recommendations = s7.ms;

        stepTimings.total = Date.now() - tStart;

        const narrativeHtml = [
          { label: "Overview", html: s1.html },
          { label: "Production Performance", html: s2.html },
          { label: "Alert Analysis", html: s3.html },
          { label: "Tag Readings", html: s4.html },
          { label: "Trend Analysis", html: s5.html },
          { label: "Risk Detection", html: s6.html },
          { label: "Recommendations", html: s7.html }
        ].map(({ label, html }) =>
          `<div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:6px;padding:18px 20px;margin-bottom:12px;">
            <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #f3f4f6;">${label}</div>
            <div style="font-size:12.5px;line-height:1.65;color:#374151;">${html}</div>
          </div>`
        ).join("\n");

        const html = renderHtmlReport({
          machineId: payload.machineId,
          windowStart,
          windowEnd,
          alerts: alertFacts.slice(0, 50),
          narrativeHtml,
          buildTimeSeconds: (stepTimings.total / 1000).toFixed(1),
          stepTimings,
          tagTrends: trendData,
          todayProducedMeters,
          productionDailyMap
        });

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

function escText(value: any): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function numberFmt(value: any, digits?: number): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", {
    maximumFractionDigits: digits === undefined ? 2 : digits
  });
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
  todayProducedMeters: number;
  productionDailyMap: Map<string, number>;
}) {
  const fmtIST = (d: Date) =>
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(d);

  const normSlug = (value: string) =>
    String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  const findTag = (slugs: string[]) => {
    const wanted = slugs.map(normSlug);
    return args.tagTrends.find(t => wanted.indexOf(normSlug(t.slug)) >= 0);
  };

  const chartPoints = (tag: TagTrendRow | undefined) => {
    return ((tag && tag.chart && tag.chart.points) || [])
      .filter(point => point && Number.isFinite(Number(point.ts)) && Number.isFinite(Number(point.v)))
      .map(point => ({ ts: Number(point.ts), v: Number(point.v) }))
      .sort((a, b) => a.ts - b.ts);
  };

  const dayKey = (ts: number) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(ts));
    const out: Record<string, string> = {};
    parts.forEach(part => { out[part.type] = part.value; });
    return `${out.year}-${out.month}-${out.day}`;
  };

  const dayLabel = (key: string) => {
    const parts = key.split("-");
    const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    return date.toLocaleDateString("en-IN", {
      timeZone: "UTC",
      day: "2-digit",
      month: "short"
    });
  };

  const groupByDay = (points: { ts: number; v: number }[]) => {
    return points.reduce((acc: Record<string, { ts: number; v: number }[]>, point) => {
      const key = dayKey(point.ts);
      if (!acc[key]) acc[key] = [];
      acc[key].push(point);
      return acc;
    }, {});
  };

  const avg = (points: { ts: number; v: number }[]) => {
    if (!points.length) return 0;
    return points.reduce((sum, p) => sum + p.v, 0) / points.length;
  };

  // ── Derive production data ──────────────────────────────────────────────────
  let dailyProductionHtml = "";

  const days = dayKeysBetween(args.windowStart, args.windowEnd);
  if (days.length) {
    const rows = days.map(key => {
      const meters = args.productionDailyMap.get(key) ?? 0;
      return {
        key,
        label: dayLabel(key),
        meters,
        rolls: 0,
        gsm: null as number | null,
        width: null as number | null,
        gsmPct: 0,
        gramPct: 0,
        mixedPct: 100,
        dominantGsm: null as number | null
      };
    });

    const rowByKey = rows.reduce((acc: Record<string, typeof rows[number]>, r) => {
      acc[r.key] = r;
      return acc;
    }, {});

    const gsmEntry = findTag(["GSM_ENTRY", "GSM ENTRY", "GSM"]);
    if (gsmEntry) {
      const gsmGroups = groupByDay(chartPoints(gsmEntry));
      Object.keys(gsmGroups).forEach(key => {
        if (rowByKey[key]) {
          rowByKey[key]!.gsm = avg(gsmGroups[key] || []);
          rowByKey[key]!.dominantGsm = rowByKey[key]!.gsm;
        }
      });
    }

    const gsmMode = findTag(["GSM_MODE_ACTIVE", "GSM MODE ACTIVE"]);
    const gramMode = findTag(["GRAM_LOGIC_MODE_ACTIVE", "GRAM LOGIC MODE ACTIVE", "GRAM_MODE_ACTIVE"]);
    if (gsmMode || gramMode) {
      days.forEach(key => {
        const gsmPoints = gsmMode ? (groupByDay(chartPoints(gsmMode))[key] || []) : [];
        const gramPoints = gramMode ? (groupByDay(chartPoints(gramMode))[key] || []) : [];
        const sampleTotal = Math.max(gsmPoints.length, gramPoints.length, 1);
        const gsmActive = gsmPoints.filter(point => point.v >= 0.5).length;
        const gramActive = gramPoints.filter(point => point.v >= 0.5).length;
        let gsmPct = Math.round((gsmActive / sampleTotal) * 100);
        let gramPct = Math.round((gramActive / sampleTotal) * 100);
        const row = rowByKey[key];
        if (!row) return;
        if (gsmPct > 80) {
          row.gsmPct = 100; row.gramPct = 0; row.mixedPct = 0;
        } else if (gramPct > 80) {
          row.gsmPct = 0; row.gramPct = 100; row.mixedPct = 0;
        } else {
          row.gsmPct = Math.min(gsmPct, 80);
          row.gramPct = Math.min(gramPct, 80);
          row.mixedPct = Math.max(0, 100 - row.gsmPct - row.gramPct);
        }
      });
    }

    const fabricWidth = findTag(["FABRIC_WIDTH", "FABRIC WIDTH"]);
    if (fabricWidth) {
      const widthGroups = groupByDay(chartPoints(fabricWidth));
      Object.keys(widthGroups).forEach(key => {
        if (rowByKey[key]) rowByKey[key]!.width = avg(widthGroups[key] || []);
      });
    }

    // ── Compute window total ────────────────────────────────────────────────
    const totalMeters = rows.reduce((sum, r) => sum + r.meters, 0);

    dailyProductionHtml = renderDailyProductionHtmlServer({
      rows,
      totalMeters,
      todayProducedMeters: args.todayProducedMeters,
      gsmEntry,
      gsmMode,
      gramMode,
      fabricWidth
    });
  }

  if (!dailyProductionHtml) {
    dailyProductionHtml = `<p style="color:#6b7280;font-size:12px;text-align:center;padding:20px 0;margin:0;">No daily production data available for this report window.</p>`;
  }

  const trendGridHtml = renderTrendCardsHtmlServer(args.tagTrends);

  // Alert rows
  const alertRows = args.alerts.map(a => {
    const sev = (a.severity || "info").toLowerCase();
    const sevColor = sev === "critical" ? "#b91c1c" : sev === "warning" ? "#92400e" : "#1e40af";
    const sevBg = sev === "critical" ? "#fef2f2" : sev === "warning" ? "#fffbeb" : "#eff6ff";
    const sevBorder = sev === "critical" ? "#fca5a5" : sev === "warning" ? "#fcd34d" : "#bfdbfe";
    return `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top;">
        <span style="display:inline-block;background-color:${sevBg};color:${sevColor};border:1px solid ${sevBorder};font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;">${esc(sev.toUpperCase())}</span>
      </td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top;color:#111827;font-size:12px;line-height:1.4;">${esc(a.title)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top;color:#6b7280;font-size:11px;white-space:nowrap;">${esc(a.startsAt)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top;color:#6b7280;font-size:11px;white-space:nowrap;">${a.durationMinutes != null ? `${a.durationMinutes}m` : "—"}</td>
    </tr>`;
  }).join("");

  // Timing chips
  const chipColors: Record<string, string> = {
    overview: "#78716c", production: "#16a34a", alerts: "#dc2626",
    tags: "#7c3aed", trends: "#0369a1", risks: "#ea580c", recommendations: "#0f766e"
  };
  const timingChips = Object.entries(args.stepTimings)
    .filter(([k]) => k !== "total")
    .map(([k, ms]) => {
      const c = chipColors[k] ?? "#6b7280";
      return `<span style="display:inline-flex;align-items:center;gap:4px;background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:3px 8px;font-size:10.5px;color:#4b5563;margin-right:5px;margin-bottom:5px;">
        <span style="width:5px;height:5px;border-radius:50%;background-color:${c};display:inline-block;flex-shrink:0;"></span>${esc(k)}: ${ms}ms
      </span>`;
    }).join("");

  // ── Full HTML ──────────────────────────────────────────────────────────────
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Production Report - ${esc(args.machineId)}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style type="text/css">
    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; -ms-interpolation-mode: bicubic; }
    a { color: #0369a1; text-decoration: none; }

    /* ── Responsive ── */
    @media only screen and (max-width: 600px) {
      .outer-wrap   { width: 100% !important; padding: 8px !important; }
      .shell        { border-radius: 6px !important; }
      .mast-td      { display: block !important; width: 100% !important; padding: 16px 16px 0 16px !important; }
      .mast-badge   { display: block !important; width: 100% !important; padding: 10px 16px 16px 16px !important; text-align: left !important; }
      .badge-inner  { min-width: 0 !important; display: block !important; }
      .meta-td      { display: block !important; width: 100% !important; border-right: 0 !important; border-bottom: 1px solid #e5e7eb !important; }
      .meta-td:last-child { border-bottom: 0 !important; }
      .section-pad  { padding: 16px !important; }
      .card-col     { display: block !important; width: 100% !important; max-width: 100% !important; padding-right: 0 !important; margin-bottom: 12px !important; }
      .alert-td-time, .alert-td-dur { display: none !important; }
      .title-h1     { font-size: 20px !important; }
      .eyebrow      { font-size: 10px !important; }
      .meta-label   { font-size: 9px !important; }
      .meta-value   { font-size: 12px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#374151;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
    <tr>
      <td align="center" style="padding:20px 12px;">

        <div class="outer-wrap" style="width:100%;max-width:880px;text-align:left;">

          <!-- Shell -->
          <table class="shell" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
            style="background-color:#ffffff;border:1px solid #d1d5db;border-radius:8px;overflow:hidden;">

            <!-- ── MASTHEAD ─────────────────────────────────────────── -->
            <tr>
              <td style="background-color:#f9fafb;border-bottom:1px solid #e5e7eb;padding:0;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                  <tr>
                    <td class="mast-td" style="padding:24px 24px 24px 28px;vertical-align:middle;">
                      <div class="eyebrow" style="color:#6b7280;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">RVL Lamination Systems</div>
                      <div class="title-h1" style="color:#111827;font-size:22px;font-weight:800;line-height:1.2;margin:0 0 6px 0;">Daily Production &amp; Operational Report</div>
                      <div style="color:#6b7280;font-size:12px;line-height:1.5;">Operational summary, alert history, and daily output logs for machine <strong style="color:#374151;">${esc(args.machineId)}</strong></div>
                    </td>
                    <td class="mast-badge" width="240" style="padding:24px 24px 24px 12px;vertical-align:middle;text-align:right;">
                      <div class="badge-inner" style="display:inline-block;background-color:#ffffff;border:1px solid #d1d5db;border-radius:6px;padding:10px 14px;text-align:left;min-width:180px;">
                        <div style="font-size:10px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">Report Window</div>
                        <div style="font-size:12.5px;font-weight:800;color:#111827;margin-top:3px;">${fmtIST(args.windowStart)}</div>
                        <div style="font-size:11px;color:#6b7280;margin-top:1px;">to ${fmtIST(args.windowEnd)}</div>
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- ── META GRID ───────────────────────────────────────── -->
            <tr>
              <td style="background-color:#f9fafb;border-bottom:1px solid #e5e7eb;padding:0;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                  <tr>
                    <td class="meta-td" style="padding:12px 16px;border-right:1px solid #e5e7eb;vertical-align:top;width:25%;">
                      <div class="meta-label" style="color:#9ca3af;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Machine</div>
                      <div class="meta-value" style="color:#111827;font-size:12.5px;font-weight:700;word-break:break-all;">${esc(args.machineId)}</div>
                    </td>
                    <td class="meta-td" style="padding:12px 16px;border-right:1px solid #e5e7eb;vertical-align:top;width:25%;">
                      <div class="meta-label" style="color:#9ca3af;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Window Start</div>
                      <div class="meta-value" style="color:#111827;font-size:12.5px;font-weight:700;">${fmtIST(args.windowStart)}</div>
                    </td>
                    <td class="meta-td" style="padding:12px 16px;border-right:1px solid #e5e7eb;vertical-align:top;width:25%;">
                      <div class="meta-label" style="color:#9ca3af;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Window End</div>
                      <div class="meta-value" style="color:#111827;font-size:12.5px;font-weight:700;">${fmtIST(args.windowEnd)}</div>
                    </td>
                    <td class="meta-td" style="padding:12px 16px;vertical-align:top;width:25%;">
                      <div class="meta-label" style="color:#9ca3af;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Build Time</div>
                      <div class="meta-value" style="color:#111827;font-size:12.5px;font-weight:700;">${args.buildTimeSeconds}s</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- ── SECTION: TREND SUMMARY ─────────────────────────── -->
            <tr>
              <td class="section-pad" style="padding:24px;border-bottom:1px solid #e5e7eb;">
                <div style="margin-bottom:14px;">
                  <div style="color:#111827;font-size:14px;font-weight:800;margin-bottom:3px;">Trend Analysis Summary</div>
                  <div style="color:#9ca3af;font-size:11px;">Statistical aggregates and trends observed across critical sensor readings.</div>
                </div>
                ${trendGridHtml}
              </td>
            </tr>

            <!-- ── SECTION: DAILY PRODUCTION ──────────────────────── -->
            <tr>
              <td class="section-pad" style="padding:24px;border-bottom:1px solid #e5e7eb;">
                <div style="margin-bottom:14px;">
                  <div style="color:#111827;font-size:14px;font-weight:800;margin-bottom:3px;">Daily Production Summary</div>
                  <div style="color:#9ca3af;font-size:11px;">Meters produced per day, GSM targets, control mode breakdown, and fabric width averages.</div>
                </div>
                ${dailyProductionHtml}
              </td>
            </tr>

            <!-- ── SECTION: OPERATIONAL NARRATIVE ─────────────────── -->
            <tr>
              <td class="section-pad" style="padding:24px;border-bottom:1px solid #e5e7eb;">
                <div style="margin-bottom:14px;">
                  <div style="color:#111827;font-size:14px;font-weight:800;margin-bottom:3px;">Operational Narrative</div>
                  <div style="color:#9ca3af;font-size:11px;">AI-generated section-by-section analysis of this production window.</div>
                </div>
                ${args.narrativeHtml}
              </td>
            </tr>

            <!-- ── SECTION: ALERT LOG ──────────────────────────────── -->
            <tr>
              <td class="section-pad" style="padding:24px;border-bottom:1px solid #e5e7eb;">
                <div style="margin-bottom:14px;">
                  <div style="color:#111827;font-size:14px;font-weight:800;margin-bottom:3px;">Alert Log</div>
                  <div style="color:#9ca3af;font-size:11px;">Status changes and threshold breaches during this window.</div>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
                  <thead>
                    <tr style="background-color:#f9fafb;">
                      <th style="padding:8px 10px;text-align:left;color:#6b7280;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Severity</th>
                      <th style="padding:8px 10px;text-align:left;color:#6b7280;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Title</th>
                      <th class="alert-td-time" style="padding:8px 10px;text-align:left;color:#6b7280;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Time (IST)</th>
                      <th class="alert-td-dur" style="padding:8px 10px;text-align:left;color:#6b7280;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-bottom:1px solid #e5e7eb;">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${alertRows || `<tr><td colspan="4" style="padding:20px;text-align:center;color:#9ca3af;font-size:12px;">No alerts detected in this report window.</td></tr>`}
                  </tbody>
                </table>
              </td>
            </tr>

            <!-- ── SECTION: BUILD PERFORMANCE ─────────────────────── -->
            <tr>
              <td class="section-pad" style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
                <div style="color:#111827;font-size:13px;font-weight:700;margin-bottom:10px;">Build Performance</div>
                <div style="font-size:0;">${timingChips}</div>
              </td>
            </tr>

            <!-- ── FOOTER ──────────────────────────────────────────── -->
            <tr>
              <td style="background-color:#f9fafb;padding:14px 24px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                  <tr>
                    <td style="color:#9ca3af;font-size:11px;">RVL Lamination System &middot; Agent Core</td>
                    <td style="color:#9ca3af;font-size:11px;text-align:right;">Generated in <strong style="color:#6b7280;">${args.buildTimeSeconds}s</strong></td>
                  </tr>
                </table>
              </td>
            </tr>

          </table>
          <!-- /Shell -->

        </div>
        <!-- /outer-wrap -->

      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ─── Server-side SVG/HTML chart renderers ─────────────────────────────────────

function renderBarChartServer(
  rows: any[],
  valueKey: string,
  options: {
    unit: string;
    yLabel: string;
    digits?: number;
    suffix?: string;
    barWidth?: number;
    height?: number;
    fillColor: string;
  }
): string {
  const width = 600;
  const height = options.height || 210;
  const pad = { top: 30, right: 16, bottom: 36, left: 52 };
  const values = rows.map(row => Number(row[valueKey] || 0));
  const maxValue = Math.max(1, Math.max(...values) * 1.18);
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const slot = innerWidth / Math.max(1, rows.length);
  const barW = Math.max(16, Math.min(options.barWidth || 32, slot * 0.58));

  const bars = rows.map((row, i) => {
    const v = Number(row[valueKey] || 0);
    const bh = (v / maxValue) * innerHeight;
    const x = pad.left + i * slot + (slot - barW) / 2;
    const y = pad.top + innerHeight - bh;
    const rollText = row.rolls ? `${row.rolls}r` : "";
    return `
      <g>
        <title>${escText(row.label + ": " + numberFmt(v, options.digits ?? 0) + " " + options.unit + (row.rolls ? ", " + row.rolls + " rolls" : "") + (row.dominantGsm ? ", GSM " + numberFmt(row.dominantGsm, 1) : ""))}</title>
        <rect fill="${options.fillColor}" opacity="0.9" rx="2" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"></rect>
        <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9.5" font-weight="700" fill="#374151" text-anchor="middle" x="${(x + barW / 2).toFixed(1)}" y="${Math.max(11, y - 5).toFixed(1)}">${escText(numberFmt(v, options.digits ?? 0))}${options.suffix ? escText(options.suffix) : ""}</text>
        ${rollText ? `<text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#6b7280" text-anchor="middle" x="${(x + barW / 2).toFixed(1)}" y="${Math.max(22, y - 16).toFixed(1)}">${escText(rollText)}</text>` : ""}
        <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9.5" fill="#9ca3af" text-anchor="middle" x="${(x + barW / 2).toFixed(1)}" y="${height - 8}">${escText(row.label)}</text>
      </g>`;
  }).join("");

  return `<svg style="display:block;width:100%;max-width:${width}px;height:${height}px;" viewBox="0 0 ${width} ${height}">
    <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9.5" fill="#9ca3af" x="0" y="14">${escText(options.yLabel)}</text>
    <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#9ca3af" text-anchor="end" x="${pad.left - 6}" y="${pad.top + 4}">${escText(numberFmt(maxValue, 0))}</text>
    <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#9ca3af" text-anchor="end" x="${pad.left - 6}" y="${pad.top + innerHeight + 4}">0</text>
    <line stroke="#e5e7eb" stroke-width="1" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + innerHeight}"></line>
    <line stroke="#e5e7eb" stroke-width="1" x1="${pad.left}" y1="${pad.top + innerHeight}" x2="${width - pad.right}" y2="${pad.top + innerHeight}"></line>
    ${bars}
  </svg>`;
}

function renderModeTimelineServer(summary: any): string {
  const rows = summary.rows;
  const width = 840;
  const rowH = 30;
  const pad = { top: 8, right: 16, bottom: 8, left: 72 };
  const innerWidth = width - pad.left - pad.right;
  const height = pad.top + pad.bottom + rows.length * rowH;

  const groups = rows.map((row: any, i: number) => {
    const y = pad.top + i * rowH + 5;
    const x = pad.left;
    const gW = innerWidth * row.gsmPct / 100;
    const grW = innerWidth * row.gramPct / 100;
    const mW = Math.max(0, innerWidth - gW - grW);
    return `<g>
      <title>${escText(row.label + ": GSM " + row.gsmPct + "%, Gram " + row.gramPct + "%, Mixed " + row.mixedPct + "%")}</title>
      <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9.5" fill="#6b7280" text-anchor="end" x="${pad.left - 8}" y="${y + 14}">${escText(row.label)}</text>
      <rect fill="#f3f4f6" x="${x}" y="${y}" width="${innerWidth}" height="18" rx="2"></rect>
      <rect fill="#0f766e" x="${x}" y="${y}" width="${gW.toFixed(1)}" height="18" rx="2"></rect>
      <rect fill="#b45309" x="${(x + gW).toFixed(1)}" y="${y}" width="${grW.toFixed(1)}" height="18"></rect>
      <rect fill="#9ca3af" x="${(x + gW + grW).toFixed(1)}" y="${y}" width="${mW.toFixed(1)}" height="18"></rect>
    </g>`;
  }).join("");

  return `<svg style="display:block;width:100%;max-width:${width}px;height:${height}px;" viewBox="0 0 ${width} ${height}">${groups}</svg>`;
}

function renderDailyProductionHtmlServer(summary: any): string {
  const { rows, totalMeters, todayProducedMeters } = summary;

  let html = "";

  // ── Today's and Window total produced banner (visual card) ─────────────────
  html += `<div style="background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:14px 16px;margin-bottom:12px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
      <tr>
        <td style="vertical-align:top;width:50%;">
          <div style="font-size:10px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;">Today's Meter Produced</div>
          <div style="font-size:24px;font-weight:800;color:#14532d;line-height:1.1;">${numberFmt(todayProducedMeters, 1)} <span style="font-size:13px;font-weight:600;color:#166534;">m</span></div>
        </td>
        <td style="vertical-align:top;width:50%;border-left:1px solid #bbf7d0;padding-left:16px;">
          <div style="font-size:10px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;">Total Produced (Window)</div>
          <div style="font-size:24px;font-weight:800;color:#14532d;line-height:1.1;">${numberFmt(totalMeters, 0)} <span style="font-size:13px;font-weight:600;color:#166534;">m</span></div>
        </td>
      </tr>
    </table>
  </div>`;

  // ── Daily table ──────────────────────────────────────────────────────────
  const tableRows = rows.map((r: any) => {
    const gsmCell = r.gsm !== null ? `${numberFmt(r.gsm, 1)} g/m²` : "—";
    const widthCell = r.width !== null ? `${numberFmt(r.width, 0)} mm` : "—";
    return `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-size:11.5px;font-weight:700;color:#374151;white-space:nowrap;">${escText(r.label)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-size:11.5px;color:#111827;font-weight:800;text-align:right;">${numberFmt(r.meters, 0)} m</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;color:#6b7280;text-align:right;">${gsmCell}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;color:#6b7280;text-align:right;">${widthCell}</td>
    </tr>`;
  }).join("") + `<tr style="background-color:#f9fafb;">
    <td style="padding:8px 10px;font-size:11.5px;font-weight:800;color:#111827;">Total</td>
    <td style="padding:8px 10px;font-size:12px;font-weight:800;color:#0f766e;text-align:right;">${numberFmt(totalMeters, 0)} m</td>
    <td colspan="2" style="padding:8px 10px;font-size:11px;color:#9ca3af;text-align:right;">${rows.length} day(s)</td>
  </tr>`;

  html += `<div style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;margin-bottom:12px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
      <thead>
        <tr style="background-color:#f9fafb;">
          <th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Date</th>
          <th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Meters</th>
          <th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Avg GSM</th>
          <th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Avg Width</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>`;

  return html;
}

function makePathServer(
  points: { ts: number; v: number }[],
  width: number,
  height: number,
  pad: { top: number; right: number; bottom: number; left: number },
  yMin: number,
  yMax: number
): string {
  if (!points.length || !points[0]) return "";
  const first = points[0];
  const last = points[points.length - 1] || first;
  const xMin = first.ts;
  const xMax = last.ts;
  const xSpan = Math.max(1, xMax - xMin);
  const ySpan = Math.max(1e-9, yMax - yMin);
  return points.map((pt, i) => {
    const x = pad.left + ((pt.ts - xMin) / xSpan) * (width - pad.left - pad.right);
    const y = pad.top + (1 - ((pt.v - yMin) / ySpan)) * (height - pad.top - pad.bottom);
    return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function renderChartServer(tag: TagTrendRow, index: number): string {
  const points = ((tag.chart && tag.chart.points) || [])
    .filter(p => p && Number.isFinite(Number(p.ts)) && Number.isFinite(Number(p.v)))
    .map(p => ({ ts: Number(p.ts), v: Number(p.v) }))
    .sort((a, b) => a.ts - b.ts);

  const width = 600;
  const height = 150;
  const pad = { top: 12, right: 10, bottom: 24, left: 42 };
  const vals = points.map(p => p.v);
  let yMin = vals.length ? Math.min(...vals) : 0;
  let yMax = vals.length ? Math.max(...vals) : 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }

  const path = makePathServer(points, width, height, pad, yMin, yMax);
  const area = path ? `${path} L${width - pad.right} ${height - pad.bottom} L${pad.left} ${height - pad.bottom} Z` : "";
  const gradId = `g${index}`;

  const timeFmt = (v: number) => !v ? "" : new Date(v).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  });

  const tStart = points.length && points[0] ? timeFmt(points[0].ts) : "";
  const tEnd = points.length && points[points.length - 1] ? timeFmt(points[points.length - 1]!.ts) : "";

  // Trend-based stroke colour
  const strokeColor = tag.trend === "rising" ? "#0f766e" : tag.trend === "falling" ? "#b91c1c" : "#6b7280";
  const fillStop = tag.trend === "rising" ? "#0f766e" : tag.trend === "falling" ? "#b91c1c" : "#6b7280";

  return `<svg style="display:block;width:100%;height:100%;" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escText(tag.name || tag.slug || "Trend")}">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${fillStop}" stop-opacity=".18"></stop>
        <stop offset="100%" stop-color="${fillStop}" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <line stroke="#e5e7eb" stroke-width="1" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
    <line stroke="#e5e7eb" stroke-width="1" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
    <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#9ca3af" x="0" y="${pad.top + 4}">${escText(numberFmt(yMax))}</text>
    <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#9ca3af" x="0" y="${height - pad.bottom + 4}">${escText(numberFmt(yMin))}</text>
    <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#9ca3af" x="${pad.left}" y="${height - 5}">${escText(tStart)}</text>
    <text font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#9ca3af" text-anchor="end" x="${width - pad.right}" y="${height - 5}">${escText(tEnd)}</text>
    ${area ? `<path d="${area}" fill="url(#${gradId})"></path>` : ""}
    ${path ? `<path fill="none" stroke="${strokeColor}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${path}"></path>` : ""}
  </svg>`;
}

function renderTrendCardsHtmlServer(trends: TagTrendRow[]): string {
  if (!trends.length) {
    return `<div style="border:1px dashed #d1d5db;background-color:#f9fafb;color:#9ca3af;padding:20px;text-align:center;font-size:11.5px;border-radius:6px;width:100%;">No trend readings available for this report window.</div>`;
  }

  const rowsHtml = trends.map((tag) => {
    const trend = (tag.trend || "stable").toLowerCase();
    const unit = tag.unit ? ` ${esc(tag.unit)}` : "";
    const count = tag.sampleCount || tag.chart?.downsampledFrom || 0;

    let trendColor = "#6b7280";
    let trendBg = "#f3f4f6";
    let trendBorder = "#e5e7eb";
    if (trend === "rising") { trendColor = "#0f766e"; trendBg = "#f0fdf4"; trendBorder = "#bbf7d0"; }
    if (trend === "falling") { trendColor = "#b91c1c"; trendBg = "#fef2f2"; trendBorder = "#fca5a5"; }

    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle;">
        <div style="color:#111827;font-size:12px;font-weight:700;">${esc(tag.name || tag.slug || "Unnamed Tag")}</div>
        <div style="color:#9ca3af;font-size:9.5px;font-weight:500;margin-top:2px;">${esc(tag.slug || "")}</div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle;text-align:center;">
        <span style="display:inline-block;background-color:${trendBg};color:${trendColor};border:1px solid ${trendBorder};font-size:9px;font-weight:800;letter-spacing:.04em;padding:2.5px 6px;border-radius:3px;text-transform:uppercase;">${esc(trend)}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle;font-size:12px;color:#111827;font-weight:800;text-align:right;">${esc(numberFmt(tag.avg))}${unit}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle;font-size:11.5px;color:#4b5563;text-align:right;">${esc(numberFmt(tag.min))}${unit}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle;font-size:11.5px;color:#4b5563;text-align:right;">${esc(numberFmt(tag.max))}${unit}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle;font-size:11px;color:#9ca3af;text-align:right;">${esc(numberFmt(count, 0))}</td>
    </tr>`;
  }).join("");

  return `<div style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;background-color:#ffffff;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
      <thead>
        <tr style="background-color:#f9fafb;">
          <th style="padding:9px 12px;text-align:left;font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Parameter</th>
          <th style="padding:9px 12px;text-align:center;font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Trend</th>
          <th style="padding:9px 12px;text-align:right;font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Avg Value</th>
          <th style="padding:9px 12px;text-align:right;font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Min</th>
          <th style="padding:9px 12px;text-align:right;font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Max</th>
          <th style="padding:9px 12px;text-align:right;font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb;">Samples</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
}