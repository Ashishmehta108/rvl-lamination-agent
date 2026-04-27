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

type ReportRunPayload = {
  runId?: string;
  scheduleId?: string;
  templateId: string;
  machineId: string;
  windowStart: string;
  windowEnd: string;
};

/* ─── Specialized Prompts for Agentic Steps ─── */

const SECTION_OVERVIEW_PROMPT = `You are an industrial reporting agent. 
Task: Write a 1-2 paragraph Executive Overview for the machine's performance in this period.
Style: Professional, concise, no fluff. Use <h3>Executive Overview</h3> as heading.
Facts provided: Machine ID, window dates, total alert counts.`;

const SECTION_ALERTS_PROMPT = `You are an industrial reporting agent.
Task: Analyze the ALERTS log provided. Group by severity and summarize any recurring issues.
Style: Use <h3>Alert Analysis</h3> as heading. Use <ul> and <li>. Mention specific alert titles.
Facts provided: List of alerts (severity, title, timestamp).`;

const SECTION_TAGS_PROMPT = `You are an industrial reporting agent.
Task: Analyze the LIVE TAG SNAPSHOT. Highlight 2-3 most critical sensors and their current values.
Style: Use <h3>Sensor Snapshot Analysis</h3> as heading. Natural prose, no raw lists. 
Facts provided: Tag slugs, values, and units.`;

const SECTION_RECOMMENDATIONS_PROMPT = `You are an industrial reporting agent.
Task: Based on the alerts and tag values, provide 3-4 specific maintenance or operational recommendations.
Style: Use <h3>Operational Recommendations</h3> as heading. Use a numbered list.
Facts provided: Summary of alerts and latest tags.`;

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
        const step1 = await runReportStep("overview", SECTION_OVERVIEW_PROMPT, {
          machineId: payload.machineId,
          window: `${payload.windowStart} to ${payload.windowEnd}`,
          totalAlerts: alerts.length
        }, runLog);
        stepTimings.overview = step1.ms;

        runLog.info("starting agentic step: alerts");
        const step2 = await runReportStep("alerts", SECTION_ALERTS_PROMPT, {
          alerts: alerts.slice(0, 50).map(a => ({ severity: a.severity, title: a.title, time: a.startsAt }))
        }, runLog);
        stepTimings.alerts = step2.ms;

        runLog.info("starting agentic step: tags");
        const step3 = await runReportStep("tags", SECTION_TAGS_PROMPT, {
          tags: tagSnapshot.slice(0, 20).map(t => ({ slug: t.slug, value: t.value, unit: t.unit }))
        }, runLog);
        stepTimings.tags = step3.ms;

        runLog.info("starting agentic step: recommendations");
        const step4 = await runReportStep("recommendations", SECTION_RECOMMENDATIONS_PROMPT, {
          alertSummary: `${alerts.length} alerts found`,
          criticalTags: tagSnapshot.slice(0, 5)
        }, runLog);
        stepTimings.recommendations = step4.ms;

        const combinedNarrative = `
          <div class="report-card">${step1.html}</div>
          <div class="report-card">${step2.html}</div>
          <div class="report-card">${step3.html}</div>
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
    const color = sev === "critical" ? "#ff4d4f" : sev === "warning" ? "#faad14" : "#1890ff";
    return `<tr>
      <td style="color:${color};font-weight:bold">${esc(sev.toUpperCase())}</td>
      <td>${esc(a.title)}</td>
      <td class="muted">${esc(a.startsAt.toISOString())}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    body { background: #0b0f14; color: #d8dee9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; line-height: 1.6; }
    .report-card { background: #141b24; border: 1px solid #1f2a36; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    h2 { color: #88c0d0; margin-top: 0; }
    h3 { color: #81a1c1; border-bottom: 1px solid #2e3440; padding-bottom: 8px; margin-top: 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #1f2a36; font-size: 13px; }
    th { background: #0f1720; color: #8aa0b6; }
    .muted { color: #8aa0b6; font-size: 12px; }
    .footer { margin-top: 40px; border-top: 1px solid #1f2a36; padding-top: 20px; font-size: 11px; color: #4c566a; display: flex; justify-content: space-between; }
    ul { padding-left: 20px; }
    li { margin-bottom: 8px; }
  </style>
</head>
<body>
  <div style="margin-bottom:32px">
    <h1 style="margin:0;color:#eceff4">Production Report</h1>
    <p class="muted">Machine: <strong>${esc(args.machineId)}</strong> | Window: ${args.windowStart.toISOString()} to ${args.windowEnd.toISOString()}</p>
  </div>

  ${args.narrativeHtml}

  <div class="report-card">
    <h3>Recent Alert Log</h3>
    <table>
      <thead><tr><th>Severity</th><th>Issue</th><th>Timestamp</th></tr></thead>
      <tbody>${alertRows || '<tr><td colspan="3" class="muted">No alerts in this window</td></tr>'}</tbody>
    </table>
  </div>

  <div class="footer">
    <span>&copy; RVL Lamination Agent</span>
    <span>Generated by <strong>${config.ollamaReportModel}</strong> in ${args.buildTimeSeconds}s</span>
  </div>
</body>
</html>`;
}
