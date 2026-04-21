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
  scheduleId?: string;
  templateId: string;
  machineId: string;
  windowStart: string;
  windowEnd: string;
};

export async function registerReportRunner(boss: PgBoss, logger: Logger) {
  await boss.work<ReportRunPayload>(Jobs.reportRun, { teamSize: 1, teamConcurrency: 2 }, async (job) => {
    const db = getPgDb();
    const payload = job.data;

    const runId = newId("run");
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
    });

    try {
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

      const html = renderHtmlReport({
        machineId: payload.machineId,
        windowStart,
        windowEnd,
        alerts
      });

      await fs.mkdir(config.artifactsDir, { recursive: true });
      const fileName = `report_${payload.machineId}_${windowStart.toISOString().slice(0, 10)}_${windowEnd.toISOString().slice(0, 10)}.html`;
      const filePath = path.resolve(config.artifactsDir, fileName);
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

      logger.info({ runId, filePath }, "report generated");
    } catch (err: any) {
      await db
        .update(schema.reportRuns)
        .set({ status: "failed", finishedAt: new Date(), error: String(err) })
        .where(eq(schema.reportRuns.id, runId));
      logger.error({ err: String(err), runId }, "report failed");
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
    <div class="muted">Machine: ${esc(args.machineId)}</div>
    <div class="muted">Window: ${esc(args.windowStart.toISOString())} → ${esc(args.windowEnd.toISOString())}</div>
    <table>
      <thead><tr><th>Severity</th><th>Title</th><th>Start</th><th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">No alerts</td></tr>`}</tbody>
    </table>
  </body>
</html>`;
}

