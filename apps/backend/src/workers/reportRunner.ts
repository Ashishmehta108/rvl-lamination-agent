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
import { chatOnceWithModel } from "../llm/ollama.js";
import { aggregateProductionMetrics, type ProductionBucket } from "../services/productionMetrics.js";
import { 
  getReportPrompt, 
  REPORT_OVERVIEW_PROMPT_ID, 
  REPORT_ALERTS_PROMPT_ID, 
  REPORT_TAGS_PROMPT_ID, 
  REPORT_PRODUCTION_PROMPT_ID,
  REPORT_RECOMMENDATIONS_PROMPT_ID 
} from "../services/promptRegistry.js";

type ReportRunPayload = {
  runId?: string;
  scheduleId?: string;
  templateId: string;
  machineId: string;
  windowStart: string;
  windowEnd: string;
};



async function buildTagSnapshot(machineId: string) {
  try {
    const prisma = getMongoClient();
    const tags = await prisma.tagLatest.findMany({
      where: { machineId },
      orderBy: { updatedAt: "desc" },
      take: 45
    });
    const defs = await prisma.tagDefinition.findMany({
      where: { machineId },
      select: { tagId: true, unit: true, name: true, slug: true }
    });
    const defMap = new Map(defs.map((d: any) => [d.tagId, d]));
    return tags.map((t: any) => {
      const def = defMap.get(t.tagId) as any;
      const val =
        t.valueNumber != null ? t.valueNumber : t.valueBool != null ? String(t.valueBool) : t.valueString ?? "N/A";
      return {
        tagId: t.tagId,
        name: def?.name ?? t.tagId,
        slug: def?.slug,
        value: val,
        unit: def?.unit ?? "",
        updatedAt: t.updatedAt?.toISOString?.() ?? ""
      };
    });
  } catch {
    return [];
  }
}

async function runReportStep(stepName: string, systemPrompt: string, facts: any, logger: Logger): Promise<{ html: string; ms: number }> {
  const t0 = Date.now();
  const userMsg = `INPUT_FACTS:\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\``;
  try {
    let raw = await chatOnceWithModel(
      [
        { role: "system", content: systemPrompt + "\nHard rules: Output ONLY HTML fragment. No markdown fences. Use only <h3>, <h4>, <p>, <ul>, <li>, <strong>." },
        { role: "user", content: userMsg }
      ],
      config.ollamaReportModel,
      {
        numCtx: config.ollamaReportNumCtx,
        temperature: config.ollamaReportTemperature,
        topP: config.ollamaTopP,
        repeatPenalty: config.ollamaRepeatPenalty,
        timeoutMs: config.ollamaReportStepTimeoutMs
      }
    );
    raw = raw.trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "");
    const ms = Date.now() - t0;
    logger.info({ stepName, ms }, "report_step_completed");
    return { html: raw, ms };
  } catch (err: any) {
    logger.warn({ stepName, err: String(err) }, "report_step_failed");
    return { html: `<p class="muted">Section unavailable (${stepName})</p>`, ms: Date.now() - t0 };
  }
}

async function fetchProductionData(machineId: string, logger: Logger): Promise<{
  daily: ProductionBucket[];
  weekly: ProductionBucket[];
  monthly: ProductionBucket[];
}> {
  try {
    const [daily, weekly, monthly] = await Promise.all([
      aggregateProductionMetrics({ machineId, granularity: "daily", buckets: 7 }),
      aggregateProductionMetrics({ machineId, granularity: "weekly", buckets: 4 }),
      aggregateProductionMetrics({ machineId, granularity: "monthly", buckets: 3 }),
    ]);
    return { daily: daily.buckets, weekly: weekly.buckets, monthly: monthly.buckets };
  } catch (err) {
    logger.warn({ err: String(err) }, "production_data_fetch_failed");
    return { daily: [], weekly: [], monthly: [] };
  }
}

function buildProductionHtmlTable(label: string, buckets: ProductionBucket[]): string {
  if (buckets.length === 0) return `<p class="muted">No ${label.toLowerCase()} data available.</p>`;
  const fmt = (n: number | null) => (n == null ? "—" : n.toLocaleString());
  const delta = (cur: number | null, prev: number | null): string => {
    if (cur == null || prev == null || prev === 0) return "";
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return "";
    const color = pct > 0 ? "#16a34a" : "#dc2626";
    const arrow = pct > 0 ? "↑" : "↓";
    return ` <span style="color:${color};font-size:10px;font-weight:600">${arrow}${Math.abs(pct)}%</span>`;
  };
  const totalMeters = buckets.reduce((s, b) => s + (b.runningMeters ?? 0), 0);
  const rows = buckets.map((b, i) => {
    const prev = i < buckets.length - 1 ? buckets[i + 1] : null;
    return `<tr>
      <td style="padding:8px 14px;border-bottom:1px solid #f0eee9;font-size:12px;font-weight:500">${esc(b.label)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0eee9;text-align:right;font-size:12px">${fmt(b.runningMeters)}${delta(b.runningMeters, prev?.runningMeters ?? null)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0eee9;text-align:right;font-size:12px">${fmt(b.avgExtruderRpm)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0eee9;text-align:right;font-size:12px">${fmt(b.avgLaminatorMpm)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0eee9;text-align:right;font-size:12px">${fmt(b.avgGsmEntry)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0eee9;text-align:right;font-size:11px;color:#a5a29d">${b.sampleCount}</td>
    </tr>`;
  }).join("");

  return `
    <h4 style="font-size:11px;font-weight:700;margin:20px 0 8px;color:#6b6964;text-transform:uppercase;letter-spacing:0.05em">${esc(label)} <span style="font-weight:400;color:#a5a29d">(Total: ${Math.round(totalMeters).toLocaleString()} m)</span></h4>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;padding:8px 14px;background:#f1efeb;color:#6b6964;font-size:10px;font-weight:600;text-transform:uppercase">Period</th>
          <th style="text-align:right;padding:8px 10px;background:#f1efeb;color:#6b6964;font-size:10px;font-weight:600;text-transform:uppercase">Meters</th>
          <th style="text-align:right;padding:8px 10px;background:#f1efeb;color:#6b6964;font-size:10px;font-weight:600;text-transform:uppercase">Avg RPM</th>
          <th style="text-align:right;padding:8px 10px;background:#f1efeb;color:#6b6964;font-size:10px;font-weight:600;text-transform:uppercase">Avg m/min</th>
          <th style="text-align:right;padding:8px 10px;background:#f1efeb;color:#6b6964;font-size:10px;font-weight:600;text-transform:uppercase">Avg GSM</th>
          <th style="text-align:right;padding:8px 10px;background:#f1efeb;color:#6b6964;font-size:10px;font-weight:600;text-transform:uppercase">Samples</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export async function registerReportRunner(boss: PgBoss, logger: Logger) {
  logger.info({ job: Jobs.reportRun }, "worker registered");

  await boss.work<ReportRunPayload>(Jobs.reportRun, { teamConcurrency: 2 } as any, async (jobs: any) => {
    for (const job of jobs) {
      const db = getPgDb();
      const payload = job.data as ReportRunPayload;
      const runId = payload.runId ?? newId("run");
      const runLog = (logger as any).child
        ? (logger as any).child({ runId, machineId: payload.machineId, scheduleId: payload.scheduleId ?? null })
        : logger;
      runLog.info({ jobId: job.id }, "report run starting");

      const tStartBuild = Date.now();
      const windowStart = new Date(payload.windowStart);
      const windowEnd = new Date(payload.windowEnd);

      // Upsert record
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
        const alerts = await db.select().from(schema.alertEvents).where(
          and(
            eq(schema.alertEvents.machineId, payload.machineId),
            gte(schema.alertEvents.startsAt, windowStart),
            lt(schema.alertEvents.startsAt, windowEnd)
          )
        ).limit(500);

        runLog.info({ alertCount: alerts.length }, "fetching tag snapshot");
        const tagSnapshot = await buildTagSnapshot(payload.machineId);

        // Multi-step Agentic Pipeline
        const stepTimings: Record<string, number> = {};

        runLog.info("starting agentic step: overview");
        const step1 = await runReportStep("overview", getReportPrompt(REPORT_OVERVIEW_PROMPT_ID), {
          machineId: payload.machineId,
          window: `${payload.windowStart} to ${payload.windowEnd}`,
          totalAlerts: alerts.length
        }, runLog);
        stepTimings.overview = step1.ms;

        runLog.info("starting agentic step: alerts");
        const step2 = await runReportStep("alerts", getReportPrompt(REPORT_ALERTS_PROMPT_ID), {
          alerts: alerts.slice(0, 50).map(a => ({ severity: a.severity, title: a.title, time: a.startsAt }))
        }, runLog);
        stepTimings.alerts = step2.ms;

        runLog.info("starting agentic step: tags");
        const step3 = await runReportStep("tags", getReportPrompt(REPORT_TAGS_PROMPT_ID), {
          tags: tagSnapshot.slice(0, 20).map(t => ({ slug: t.slug, value: t.value, unit: t.unit }))
        }, runLog);
        stepTimings.tags = step3.ms;

        // Production metrics step
        runLog.info("fetching production metrics");
        const productionData = await fetchProductionData(payload.machineId, runLog);
        const hasProduction = productionData.daily.length > 0 || productionData.weekly.length > 0 || productionData.monthly.length > 0;

        let step3b = { html: "<p class=\"muted\">No production data available for this period.</p>", ms: 0 };
        if (hasProduction) {
          runLog.info("starting agentic step: production");
          step3b = await runReportStep("production", getReportPrompt(REPORT_PRODUCTION_PROMPT_ID), {
            daily: productionData.daily.map(b => ({ period: b.label, meters: b.runningMeters, avgRpm: b.avgExtruderRpm, avgMpm: b.avgLaminatorMpm, avgGsm: b.avgGsmEntry })),
            weekly: productionData.weekly.map(b => ({ period: b.label, meters: b.runningMeters, avgRpm: b.avgExtruderRpm, avgMpm: b.avgLaminatorMpm, avgGsm: b.avgGsmEntry })),
            monthly: productionData.monthly.map(b => ({ period: b.label, meters: b.runningMeters, avgRpm: b.avgExtruderRpm, avgMpm: b.avgLaminatorMpm, avgGsm: b.avgGsmEntry })),
          }, runLog);
          stepTimings.production = step3b.ms;
        }

        // Build deterministic production tables
        const productionTablesHtml = hasProduction
          ? [
            buildProductionHtmlTable("Daily (Last 7 Days)", productionData.daily),
            buildProductionHtmlTable("Weekly (Last 4 Weeks)", productionData.weekly),
            buildProductionHtmlTable("Monthly (Last 3 Months)", productionData.monthly),
          ].join("")
          : "";

        runLog.info("starting agentic step: recommendations");
        const step4 = await runReportStep("recommendations", getReportPrompt(REPORT_RECOMMENDATIONS_PROMPT_ID), {
          alertSummary: `${alerts.length} alerts found`,
          criticalTags: tagSnapshot.slice(0, 5),
          productionSummary: hasProduction
            ? `Daily meters: ${productionData.daily.map(b => b.runningMeters ?? 0).join(", ")}. Weekly: ${productionData.weekly.map(b => b.runningMeters ?? 0).join(", ")}.`
            : "No production data available."
        }, runLog);
        stepTimings.recommendations = step4.ms;

        const combinedNarrative = `
          <div class="report-card">${step1.html}</div>
          <div class="report-card">${step2.html}</div>
          <div class="report-card">${step3.html}</div>
          <div class="report-card">
            ${step3b.html}
            ${productionTablesHtml}
          </div>
          <div class="report-card">${step4.html}</div>
        `;

        const totalBuildTimeMs = Date.now() - tStartBuild;
        stepTimings.total = totalBuildTimeMs;

        const html = renderHtmlReport({
          machineId: payload.machineId,
          windowStart,
          windowEnd,
          alerts: alerts.slice(0, 50),
          narrativeHtml: combinedNarrative,
          buildTimeSeconds: (totalBuildTimeMs / 1000).toFixed(1)
        });

        const artifactsPath = path.resolve(process.cwd(), config.artifactsDir);
        await fs.mkdir(artifactsPath, { recursive: true });
        const fileName = `report_${payload.machineId}_${runId}.html`;
        const filePath = path.resolve(artifactsPath, fileName);
        await fs.writeFile(filePath, html, "utf8");

        const checksum = crypto.createHash("sha256").update(html).digest("hex");
        const bytes = Buffer.byteLength(html, "utf8");
        const artifactId = newId("artifact");

        await db.insert(schema.reportArtifacts).values({
          id: artifactId,
          runId,
          type: "html",
          uri: filePath,
          checksum,
          bytes
        });

        await db.update(schema.reportRuns).set({
          status: "succeeded",
          finishedAt: new Date(),
          metrics: { stepTimings, totalAlerts: alerts.length, tagCount: tagSnapshot.length } as any
        }).where(eq(schema.reportRuns.id, runId));

        if (config.reportEmailTo.length > 0) {
          await boss.send(Jobs.reportEmail, { runId });
        }
      } catch (err: any) {
        runLog.error({ err: String(err) }, "report runner failed");
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

function esc(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderHtmlReport(args: {
  machineId: string;
  windowStart: Date;
  windowEnd: Date;
  alerts: any[];
  narrativeHtml: string;
  buildTimeSeconds: string;
}) {
  const alertRows = args.alerts.map(a => {
    const sev = (a.severity || "info").toLowerCase();
    const color = sev === "critical" ? "#b91c1c" : sev === "warning" ? "#b45309" : "#1d4ed8";
    const bg = sev === "critical" ? "#fef2f2" : sev === "warning" ? "#fffbeb" : "#eff6ff";
    return `<tr>
      <td style="padding: 10px 14px; border-bottom: 1px solid #f0eee9;"><span style="color:${color};background:${bg};font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700;display:inline-block;">${esc(sev.toUpperCase())}</span></td>
      <td style="padding: 10px 8px; border-bottom: 1px solid #f0eee9; color: #3a3834; font-size: 12px;">${esc(a.title)}</td>
      <td style="padding: 10px 14px; border-bottom: 1px solid #f0eee9; color: #a5a29d; font-size: 11px; text-align: right;">${esc(a.startsAt.toISOString().replace('T', ' ').slice(0, 16))}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 0; background-color: #f9f8f6; }
    .report-card { 
      background-color: #ffffff; 
      border: 1px solid #e5e2dd; 
      border-radius: 10px; 
      padding: 24px; 
      margin-bottom: 24px; 
    }
    h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px; color: #3a3834; }
    h2 { font-size: 16px; font-weight: 700; margin: 0 0 16px; color: #3a3834; border-bottom: 1px solid #e5e2dd; padding-bottom: 8px; }
    h3 { font-size: 14px; font-weight: 700; margin: 24px 0 12px; color: #3a3834; }
    h4 { font-size: 12px; font-weight: 700; margin: 16px 0 8px; color: #6b6964; text-transform: uppercase; letter-spacing: 0.05em; }
    p { font-size: 12.5px; margin: 0 0 12px; color: #3a3834; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px 14px; background-color: #f1efeb; color: #6b6964; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .muted { color: #a5a29d; font-size: 11.5px; }
    ul { padding-left: 18px; margin: 0 0 16px; }
    li { margin-bottom: 6px; font-size: 12.5px; color: #3a3834; }
    @media (max-width: 600px) {
      .report-card { padding: 16px !important; }
    }
  </style>
</head>
<body style="background-color: #f9f8f6; color: #3a3834; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px 20px; line-height: 1.6;">
  <div style="max-width: 720px; margin: 0 auto;">
    <div style="margin-bottom: 32px; border-bottom: 1px solid #e5e2dd; padding-bottom: 20px;">
      <h1 style="font-size: 20px; margin: 0 0 8px;">Production Report</h1>
      <div style="display: flex; gap: 12px;">
        <span class="muted">Machine: <strong style="color: #9e5a32;">${esc(args.machineId)}</strong></span>
        <span class="muted" style="border-left: 1px solid #e5e2dd; padding-left: 12px;">Period: <strong>${args.windowStart.toISOString().slice(0, 10)}</strong> to <strong>${args.windowEnd.toISOString().slice(0, 10)}</strong></span>
      </div>
    </div>

    <div class="narrative-sections">
      ${args.narrativeHtml}
    </div>

    <div class="report-card" style="margin-top: 32px; background-color: #ffffff; border: 1px solid #e5e2dd; border-radius: 10px; padding: 24px;">
      <h2 style="font-size: 16px; margin: 0 0 16px; border-bottom: 1px solid #e5e2dd; padding-bottom: 8px;">Recent Alert Log</h2>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead><tr><th style="border-radius: 6px 0 0 0; background-color: #f1efeb; padding: 10px 14px;">Severity</th><th style="background-color: #f1efeb; padding: 10px 14px;">Issue</th><th style="border-radius: 0 6px 0 0; text-align: right; padding: 10px 14px; background-color: #f1efeb;">Timestamp</th></tr></thead>
          <tbody>${alertRows || '<tr><td colspan="3" class="muted" style="padding: 24px; text-align: center;">No alerts recorded in this window</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div style="margin-top: 48px; border-top: 1px solid #e5e2dd; padding-top: 24px; font-size: 11px; color: #a5a29d; display: flex; justify-content: space-between;">
      <span>&copy; RVL Lamination Agent &middot; Secure Industrial Intelligence</span>
      <span>AI Analysis &middot; ${args.buildTimeSeconds}s</span>
    </div>
  </div>
</body>
</html>`;
}

