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
    };
    const acc = new Map<string, Acc>();
    for (const d of defs) {
      acc.set(d.tagId, {
        n: 0, mean: 0, M2: 0, min: Infinity, max: -Infinity,
        pos: 0,
        earlySum: 0, earlyN: 0,
        lateBuf: new Float64Array(BUCKET), lateHead: 0, lateBufN: 0,
      });
    }

    const samples = await prisma.tagSample.findMany({
      where: {
        machineId,
        tagId: { in: defs.map(d => d.tagId) },
        ts: { gte: windowStart, lte: windowEnd },
        valueNumber: { not: null }
      },
      select: { tagId: true, valueNumber: true },
      orderBy: { ts: "asc" },
      take: 10_000
    }) as Array<{ tagId: string; valueNumber: number }>;

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

      return {
        slug: def.slug,
        name: def.name,
        unit: def.unit ?? "",
        min, max, avg, stdDev,
        trend,
        summary,
        sampleCount: a.n,
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
          stepTimings
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
  <title>Production Report — ${esc(args.machineId)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #f9f8f6;
      color: #3a3834;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      line-height: 1.65;
      -webkit-font-smoothing: antialiased;
      padding: 0;
    }
    .page-wrap { max-width: 820px; margin: 0 auto; padding: 40px 24px 64px; }

    /* Header banner */
    .report-header {
      background: #ffffff;
      border: 1px solid #e5e2dd;
      border-radius: 14px;
      padding: 28px 28px 24px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,.04);
    }
    .report-header-top { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
    .report-logo {
      width: 44px; height: 44px; border-radius: 11px;
      background: #f5ede5; border: 1px solid #e8d8cc;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; flex-shrink: 0;
    }
    .report-title { font-size: 20px; font-weight: 700; color: #1a1917; letter-spacing: -0.02em; }
    .report-sub { font-size: 13px; color: #6b6964; margin-top: 2px; }
    .report-meta { display: flex; flex-wrap: wrap; gap: 8px; }
    .meta-chip {
      display: inline-flex; align-items: center; gap: 5px;
      background: #f1efeb; border: 1px solid #e5e2dd;
      border-radius: 6px; padding: 4px 10px;
      font-size: 11.5px; color: #6b6964; font-weight: 500;
    }
    .meta-chip strong { color: #3a3834; font-weight: 600; }

    /* Cards */
    .report-card {
      background: #ffffff;
      border: 1px solid #e5e2dd;
      border-radius: 12px;
      padding: 22px 24px;
      margin-bottom: 16px;
      box-shadow: 0 1px 2px rgba(0,0,0,.03);
    }
    .card-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 13px; font-weight: 700; color: #3a3834;
      text-transform: uppercase; letter-spacing: .07em;
      padding-bottom: 12px; margin-bottom: 16px;
      border-bottom: 1px solid #f0eee9;
    }
    .card-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    /* Narrative text from LLM */
    .report-card h3 { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #3a3834; border-bottom: 1px solid #f0eee9; padding-bottom: 12px; margin-bottom: 16px; }
    .report-card h4 { font-size: 13px; font-weight: 600; color: #3a3834; margin: 14px 0 6px; }
    .report-card p  { color: #3a3834; margin-bottom: 10px; line-height: 1.75; }
    .report-card ul { padding-left: 20px; margin-bottom: 10px; }
    .report-card li { margin-bottom: 6px; line-height: 1.7; color: #3a3834; }
    .report-card strong { font-weight: 600; color: #1a1917; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
    thead tr { background: #f9f8f6; }
    th { text-align: left; padding: 9px 12px; color: #6b6964; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; border-bottom: 1px solid #e5e2dd; }
    td { padding: 9px 12px; border-bottom: 1px solid #f0eee9; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .muted { color: #8a8882; font-size: 11.5px; }

    /* Footer */
    .report-footer {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 1px solid #e5e2dd;
      display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;
      font-size: 11px; color: #a5a29d;
    }
    .report-footer a { color: #9e5a32; text-decoration: none; }

    @media (max-width: 600px) {
      .page-wrap { padding: 20px 14px 48px; }
      .report-header { padding: 20px; }
      .report-card { padding: 18px; }
    }
  </style>
</head>
<body>
  <div class="page-wrap">

    <!-- Header -->
    <div class="report-header">
      <div class="report-header-top">
        <div class="report-logo">⚙️</div>
        <div>
          <div class="report-title">Production Report</div>
          <div class="report-sub">RVL Lamination Monitoring System</div>
        </div>
      </div>
      <div class="report-meta">
        <span class="meta-chip">Machine: <strong>${esc(args.machineId)}</strong></span>
        <span class="meta-chip">From: <strong>${fmtIST(args.windowStart)}</strong></span>
        <span class="meta-chip">To: <strong>${fmtIST(args.windowEnd)}</strong></span>
        <span class="meta-chip">Built in: <strong>${args.buildTimeSeconds}s</strong></span>
      </div>
    </div>

    <!-- Narrative sections -->
    ${args.narrativeHtml}

    <!-- Alert log -->
    <div class="report-card">
      <h3><span class="card-dot" style="background:#dc2626"></span>Alert Log</h3>
      <table>
        <thead><tr><th>Severity</th><th>Title</th><th>Time (IST)</th><th>Duration</th></tr></thead>
        <tbody>${alertRows || '<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">No alerts in this window ✓</td></tr>'}</tbody>
      </table>
    </div>

    <!-- Build timing -->
    <div class="report-card">
      <h3><span class="card-dot" style="background:#9e5a32"></span>Build Performance</h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
        ${timingChips}
      </div>
    </div>

    <div class="report-footer">
      <span>&copy; RVL Lamination Agent</span>
      <span>Generated by <strong>${config.aiProvider === "bedrock" ? config.bedrockReportModelId : config.geminiReportModel}</strong></span>
    </div>
  </div>
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
