import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import fs from "node:fs/promises";
import { getPgDb, schema } from "@rvl/db-postgres";
import { and, eq } from "drizzle-orm";

import { Jobs } from "./jobs.js";
import { config } from "../config.js";
import { getSmtpTransport, smtpFromAddress } from "../email/smtpTransport.js";

type ReportEmailPayload = { runId: string };

function smtpFallbackUser(): string {
  return process.env.SMTP_USER ?? process.env.SENDER_EMAIL ?? "rvl-agent@localhost";
}

export async function registerReportEmailWorker(boss: PgBoss, logger: Logger) {
  await boss.work<ReportEmailPayload>(Jobs.reportEmail, { teamConcurrency: 2 } as any, async (jobs: any) => {
    for (const job of jobs) {
      const db = getPgDb();
      const runId = (job.data as ReportEmailPayload).runId;
      const runLog = (logger as any).child ? (logger as any).child({ runId }) : logger;

      const mergeEmailMetrics = async (patch: Record<string, unknown>) => {
        const [row] = await db.select({ metrics: schema.reportRuns.metrics }).from(schema.reportRuns).where(eq(schema.reportRuns.id, runId));
        const prev = (row?.metrics as Record<string, unknown>) ?? {};
        await db
          .update(schema.reportRuns)
          .set({ metrics: { ...prev, ...patch } as any })
          .where(eq(schema.reportRuns.id, runId));
      };

      if (config.reportEmailTo.length === 0) {
        runLog.info("report email skipped — REPORT_EMAIL_TO empty");
        continue;
      }

      const transport = getSmtpTransport();
      if (!transport) {
        await mergeEmailMetrics({
          emailSent: false,
          emailError: "SMTP not configured",
          emailAttemptedAt: new Date().toISOString()
        });
        runLog.warn("report email failed — SMTP not configured");
        continue;
      }

      try {
        const [run] = await db.select().from(schema.reportRuns).where(eq(schema.reportRuns.id, runId));
        if (!run) {
          await mergeEmailMetrics({ emailSent: false, emailError: "run_not_found" });
          continue;
        }

        const [artifact] = await db
          .select()
          .from(schema.reportArtifacts)
          .where(and(eq(schema.reportArtifacts.runId, runId), eq(schema.reportArtifacts.type, "html")))
          .limit(1);

        if (!artifact?.uri) {
          await mergeEmailMetrics({ emailSent: false, emailError: "artifact_not_found" });
          continue;
        }

        const html = await fs.readFile(artifact.uri, "utf8");
        const windowLabel = `${run.windowStart.toISOString().slice(0, 10)} → ${run.windowEnd.toISOString().slice(0, 10)}`;
        
        const metrics = (run.metrics as any) || {};
        const buildTimeMs = metrics.stepTimings?.total;
        const buildSuffix = buildTimeMs ? ` (built in ${(buildTimeMs / 1000).toFixed(1)}s)` : "";
        const subject = `RVL production report — ${run.machineId} — ${windowLabel}${buildSuffix}`;

        await transport.sendMail({
          from: smtpFromAddress(smtpFallbackUser()),
          to: config.reportEmailTo.join(", "),
          subject,
          html,
          text: `Report for machine ${run.machineId} (${windowLabel}). Open the HTML part of this message for the full report.`
        });

        await mergeEmailMetrics({
          emailSent: true,
          emailError: null,
          emailSentAt: new Date().toISOString(),
          emailToCount: config.reportEmailTo.length
        });
        runLog.info({ recipients: config.reportEmailTo.length }, "report email sent");
      } catch (err: any) {
        await mergeEmailMetrics({
          emailSent: false,
          emailError: String(err?.message ?? err).slice(0, 500),
          emailAttemptedAt: new Date().toISOString()
        });
        runLog.warn({ err: String(err) }, "report email failed");
        throw err;
      }
    }
  });
}
