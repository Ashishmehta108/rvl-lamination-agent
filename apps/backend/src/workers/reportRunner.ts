import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getPgDb, schema } from "@rvl/db-postgres";
import { and, eq, gte, lt } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { config } from "../config.js";
import { Jobs } from "./jobs.js";

type ReportRunPayload = {
  runId?: string;
  scheduleId?: string;
  templateId: string;
  machineId: string;
  windowStart: string;
  windowEnd: string;
};

export async function registerReportRunner(boss: PgBoss, logger: Logger) {
  logger.info({ job: Jobs.reportRun }, "worker registered");

  await boss.work<ReportRunPayload>(Jobs.reportRun, { teamConcurrency: 2 } as any, async (job: any) => {
    const db = getPgDb();
    const payload = job.data as ReportRunPayload;
    const runId = payload.runId ?? newId("run");
    const runLog = (logger as any).child
      ? (logger as any).child({ runId, machineId: payload.machineId, scheduleId: payload.scheduleId ?? null })
      : logger;
    runLog.info({ jobId: job.id }, "report run starting");

    const windowStart = new Date(payload.windowStart);
    const windowEnd = new Date(payload.windowEnd);

    // If trigger created a queued run already, transition it; otherwise create a fresh run.
    const updated = await db
      .update(schema.reportRuns)
      .set({
        scheduleId: payload.scheduleId ?? null,
        templateId: payload.templateId,
        machineId: payload.machineId,
        status: "running",
        windowStart,
        windowEnd,
        startedAt: new Date()
      })
      .where(eq(schema.reportRuns.id, runId))
      .returning({ id: schema.reportRuns.id });

    if (updated.length === 0) {
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
      });
    }

    try {
      runLog.info({ windowStart: payload.windowStart, windowEnd: payload.windowEnd }, "fetching alerts for report");
      const alerts = await db
        .select()
        .from(schema.alertEvents)
        .where(
          and(
            eq(schema.alertEvents.machineId, payload.machineId),
            gte(schema.alertEvents.startsAt, windowStart),
            lt(schema.alertEvents.startsAt, windowEnd)
          )
        )
        .limit(2000);

      runLog.info({ alerts: alerts.length }, "rendering report html");
      const html = renderHtmlReport({
        machineId: payload.machineId,
        windowStart,
        windowEnd,
        alerts
      });

      const artifactsPath = path.resolve(process.cwd(), config.artifactsDir);
      await fs.mkdir(artifactsPath, { recursive: true });
      
      const fileName = `report_${payload.machineId}_${runId}.html`;
      const filePath = path.resolve(artifactsPath, fileName);

      runLog.info({ filePath }, "writing report artifact");
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

      await db
        .update(schema.reportRuns)
        .set({ status: "succeeded", finishedAt: new Date(), metrics: { alerts: alerts.length } })
        .where(eq(schema.reportRuns.id, runId));

      runLog.info({ filePath }, "report generated");
    } catch (err: any) {
      await db
        .update(schema.reportRuns)
        .set({ status: "failed", finishedAt: new Date(), error: String(err) })
        .where(eq(schema.reportRuns.id, runId));
      runLog.error({ err: String(err) }, "report failed");
      throw err;
    }
  });
}

function esc(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderHtmlReport(args: { machineId: string; windowStart: Date; windowEnd: Date; alerts: any[] }) {
  const rows = args.alerts
    .map(
      (a) =>
        `<tr><td>${esc(a.severity)}</td><td>${esc(a.title)}</td><td>${esc(a.startsAt.toISOString())}</td><td>${esc(
          a.status
        )}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="dark" />
    <title>RVL Report</title>
    <style>
      body{background:#0b0f14;color:#d8dee9;font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th,td{border:1px solid #1f2a36;padding:8px;text-align:left;font-size:12px}
      th{background:#0f1720}
      .muted{color:#8aa0b6}
    </style>
  </head>
  <body>
    <h2>RVL Lamination Agent Report</h2>
    <p>Machine: ${esc(args.machineId)}</p>
    <p class="muted">Window: ${esc(args.windowStart.toISOString())} → ${esc(args.windowEnd.toISOString())}</p>
    <table>
      <thead><tr><th>Severity</th><th>Title</th><th>Start</th><th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">No alerts in this period</td></tr>`}</tbody>
    </table>
  </body>
</html>`;
}
