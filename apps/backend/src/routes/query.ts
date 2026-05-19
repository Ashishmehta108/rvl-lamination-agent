import type { FastifyInstance } from "fastify";
import { requireApiAuth, validateMachineAccess } from "../auth.js";
import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { desc, eq, and, sql, gte, lt } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { tryGetBoss } from "../queue/boss.js";
import { Jobs } from "../workers/jobs.js";
import fs from "node:fs/promises";
import { config } from "../config.js";
import {
  aggregateProductionMetrics,
  exportProductionSamplesCsv,
  type ProductionGranularity
} from "../services/productionMetrics.js";
import { verifySmtpTransport, getSmtpTransport, smtpFromAddress } from "../email/smtpTransport.js";

export async function registerQueryRoutes(app: FastifyInstance) {
  app.post("/debug/boss/send", async (req, reply) => {
    requireApiAuth(req);
    const name = String((req.body as any)?.name ?? "");
    if (!name) return reply.code(400).send({ error: "name_required" });
    const boss = await tryGetBoss();
    if (!boss) return reply.code(500).send({ error: "queue_not_available" });
    try {
      await (boss as any).createQueue?.(name);
    } catch {
      // ignore
    }
    const id = await boss.send(name, { t: Date.now() });
    const db = getPgDb();
    const schemaName = config.queueSchema;
    const q = await db.execute(sql`select * from ${sql.identifier(schemaName)}.queue where name = ${name}`);
    const j = await db.execute(sql`select count(*)::int as count from ${sql.identifier(schemaName)}.job where name = ${name}`);
    return reply.send({
      id,
      bossState: typeof (boss as any).getState === "function" ? await (boss as any).getState() : null,
      queue: (q as any).rows ?? [],
      jobs: (j as any).rows?.[0]?.count ?? 0
    });
  });

  app.post("/debug/alerts/seed", async (req, reply) => {
    requireApiAuth(req);
    if (config.nodeEnv === "production") return reply.code(403).send({ error: "forbidden_in_production" });
    const machineId = String((req.body as any)?.machineId ?? "");
    if (!machineId) return reply.code(400).send({ error: "machineId_required" });
    validateMachineAccess(machineId);

    const severity = (String((req.body as any)?.severity ?? "warning").toLowerCase() as any) === "critical"
      ? "critical"
      : "warning";
    const title = String((req.body as any)?.title ?? "Seeded test alert");
    const description = String((req.body as any)?.description ?? "Dev-only seeded alert event for UI testing.");
    const tagId = String((req.body as any)?.tagId ?? "WINDER_TENSION_PCT");

    const db = getPgDb();
    const alertId = newId("alert");
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(schema.alertEvents).values({
        id: alertId,
        machineId,
        ruleId: null,
        severity,
        status: "open",
        title,
        description,
        dedupeKey: `seed:${alertId}`,
        payload: { kind: "seed", tagId },
        startsAt: now
      });
      await tx.insert(schema.alertTags).values({
        alertEventId: alertId,
        tagId,
        tagSnapshot: { tagId, slug: tagId, name: tagId, unit: null, department: null }
      });
    });

    return reply.send({ ok: true, alertId });
  });

  app.get("/debug/boss/methods", async (req, reply) => {
    requireApiAuth(req);
    const boss = await tryGetBoss();
    if (!boss) return reply.code(500).send({ error: "queue_not_available" });
    const keys = new Set<string>();
    let obj: any = boss;
    while (obj && obj !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(obj)) keys.add(k);
      obj = Object.getPrototypeOf(obj);
    }
    const methods = [...keys].filter((k) => typeof (boss as any)[k] === "function").sort();
    return reply.send({ methods });
  });

  app.get("/debug/queue", async (req, reply) => {
    requireApiAuth(req);
    const name = String((req.query as any)?.name ?? "");
    const db = getPgDb();
    const schemaName = String((req.query as any)?.schema ?? config.queueSchema);
    const res = name
      ? await db.execute(
        sql`select state, count(*)::int as count from ${sql.identifier(schemaName)}.job where name = ${name} group by state order by state`
      )
      : await db.execute(
        sql`select state, count(*)::int as count from ${sql.identifier(schemaName)}.job group by state order by state`
      );
    return reply.send({ name: name || null, schema: schemaName, states: (res as any).rows ?? [] });
  });

  app.get("/debug/pg/tables", async (req, reply) => {
    requireApiAuth(req);
    const schemaName = String((req.query as any)?.schema ?? "public");
    const db = getPgDb();
    const res = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = ${schemaName} order by table_name`
    );
    return reply.send({ schema: schemaName, tables: (res as any).rows?.map((r: any) => r.table_name) ?? [] });
  });

  app.get("/debug/pg/info", async (req, reply) => {
    requireApiAuth(req);
    const db = getPgDb();
    const res = await db.execute(
      sql`select current_database() as db, current_user as user, current_setting('search_path') as search_path`
    );
    return reply.send({ pg: (res as any).rows?.[0] ?? null, queueSchema: config.queueSchema });
  });

  app.get("/debug/pg/count", async (req, reply) => {
    requireApiAuth(req);
    const schemaName = String((req.query as any)?.schema ?? "public");
    const table = String((req.query as any)?.table ?? "");
    if (!table) return reply.code(400).send({ error: "table_required" });
    const db = getPgDb();
    const res = await db.execute(sql`select count(*)::int as count from ${sql.identifier(schemaName)}.${sql.identifier(table)}`);
    return reply.send({ schema: schemaName, table, count: (res as any).rows?.[0]?.count ?? 0 });
  });

  app.get("/debug/pg/rows", async (req, reply) => {
    requireApiAuth(req);
    const schemaName = String((req.query as any)?.schema ?? "public");
    const table = String((req.query as any)?.table ?? "");
    const limit = Math.min(50, Math.max(1, Number((req.query as any)?.limit ?? 10)));
    if (!table) return reply.code(400).send({ error: "table_required" });
    const db = getPgDb();
    const res = await db.execute(sql`select * from ${sql.identifier(schemaName)}.${sql.identifier(table)} limit ${limit}`);
    return reply.send({ schema: schemaName, table, rows: (res as any).rows ?? [] });
  });

  app.get("/tags/latest", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    validateMachineAccess(machineId);

    const prisma = getMongoClient();
    const items = await prisma.tagLatest.findMany({ 
      where: { machineId }, 
      orderBy: { updatedAt: 'desc' },
      take: 500 
    });

    // Fetch definitions for this machine to get human-readable slugs/names
    const definitions = await prisma.tagDefinition.findMany({
      where: { machineId },
      select: { tagId: true, slug: true, name: true }
    });

    const defMap = new Map(definitions.map((d: any) => [d.tagId, d]));

    const enhancedItems = items.map((item: any) => ({
      ...item,
      slug: (defMap.get(item.tagId) as any)?.slug || item.tagId,
      name: (defMap.get(item.tagId) as any)?.name || item.tagId,
    }));

    return reply.send({ items: enhancedItems });
  });

  app.get("/metrics/production", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    validateMachineAccess(machineId);
    const g = String((req.query as any)?.granularity ?? "daily").toLowerCase();
    const granularity = (g === "weekly" || g === "monthly" ? g : "daily") as ProductionGranularity;
    const bucketsRaw = Number((req.query as any)?.buckets ?? 30);
    const buckets = Number.isFinite(bucketsRaw) ? Math.floor(bucketsRaw) : 30;
    const fromISO = (req.query as any)?.from != null ? String((req.query as any).from) : undefined;
    const toISO = (req.query as any)?.to != null ? String((req.query as any).to) : undefined;
    try {
      const result = await aggregateProductionMetrics({
        machineId,
        granularity,
        buckets,
        fromISO,
        toISO
      });
      return reply.send(result);
    } catch (err: any) {
      req.log.error({ err: String(err) }, "metrics_production_failed");
      return reply.code(500).send({ error: "metrics_aggregation_failed" });
    }
  });

  app.get("/metrics/production/samples", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    validateMachineAccess(machineId);
    const fromISO = String((req.query as any)?.from ?? "");
    const toISO = String((req.query as any)?.to ?? "");
    if (!fromISO || !toISO) {
      return reply.code(400).send({ error: "from_and_to_required" });
    }
    try {
      const tagsRaw = (req.query as any)?.tags;
      const tags = typeof tagsRaw === "string" ? tagsRaw.split(",") : Array.isArray(tagsRaw) ? tagsRaw : undefined;
      const { csv, from, to } = await exportProductionSamplesCsv({ machineId, fromISO, toISO, tags });
      reply.header("Content-Disposition", `attachment; filename="data-${machineId}-${from.slice(0, 10)}_${to.slice(0, 10)}.csv"`);
      return reply.type("text/csv; charset=utf-8").send(csv);
    } catch (err: any) {
      if (String(err?.message) === "invalid_date_range") {
        return reply.code(400).send({ error: "invalid_date_range" });
      }
      req.log.error({ err: String(err) }, "metrics_production_samples_failed");
      return reply.code(500).send({ error: "export_failed" });
    }
  });

  app.get("/alerts", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    const status = (req.query as any)?.status ? String((req.query as any).status) : undefined;
    const severity = (req.query as any)?.severity ? String((req.query as any).severity) : undefined;
    const date = (req.query as any)?.date ? String((req.query as any).date) : undefined;
    const fromRaw = (req.query as any)?.from ? String((req.query as any).from) : undefined;
    const toRaw = (req.query as any)?.to ? String((req.query as any).to) : undefined;
    validateMachineAccess(machineId);
    const db = getPgDb();
    const filters = [eq(schema.alertEvents.machineId, machineId)];
    if (status && status !== "all") filters.push(eq(schema.alertEvents.status, status as any));
    if (severity && severity !== "all") filters.push(eq(schema.alertEvents.severity, severity as any));
    const dateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
    const istStart = (value: string) => new Date(`${value}T00:00:00+05:30`);
    let from: Date | null = null;
    let to: Date | null = null;
    if (date) {
      from = istStart(date);
      to = new Date(from);
      to.setUTCDate(to.getUTCDate() + 1);
    } else if (fromRaw) {
      from = dateOnly(fromRaw) ? istStart(fromRaw) : new Date(fromRaw);
      if (toRaw) {
        to = dateOnly(toRaw) ? istStart(toRaw) : new Date(toRaw);
        if (dateOnly(toRaw)) to.setUTCDate(to.getUTCDate() + 1);
      }
    }
    if (from && !Number.isNaN(from.getTime())) filters.push(gte(schema.alertEvents.startsAt, from));
    if (to && !Number.isNaN(to.getTime())) filters.push(lt(schema.alertEvents.startsAt, to));
    const items = await db.select().from(schema.alertEvents).where(and(...filters)).orderBy(desc(schema.alertEvents.startsAt)).limit(200);
    return reply.send({
      query: {
        machineId,
        status: status ?? "all",
        severity: severity ?? "all",
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
        timezoneAssumption: date || (fromRaw && dateOnly(fromRaw)) ? "date-only inputs interpreted as Asia/Kolkata local days" : "explicit timestamps"
      },
      items
    });
  });

  app.get("/reports/runs", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    validateMachineAccess(machineId);
    const limitRaw = Number((req.query as any)?.limit ?? 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 10));
    const db = getPgDb();
    const items = await db
      .select({
        id: schema.reportRuns.id,
        status: schema.reportRuns.status,
        createdAt: schema.reportRuns.createdAt,
        windowStart: schema.reportRuns.windowStart,
        windowEnd: schema.reportRuns.windowEnd,
        metrics: schema.reportRuns.metrics,
      })
      .from(schema.reportRuns)
      .where(eq(schema.reportRuns.machineId, machineId))
      .orderBy(desc(schema.reportRuns.createdAt))
      .limit(limit);
    return reply.send({ items });
  });

  app.get("/reports/runs/:runId", async (req, reply) => {
    requireApiAuth(req);
    const runId = String((req.params as any)?.runId ?? "");
    if (!runId) return reply.code(400).send({ error: "runId_required" });
    const machineId = String((req.query as any)?.machineId ?? "");
    validateMachineAccess(machineId);
    const db = getPgDb();
    const [full] = await db
      .select()
      .from(schema.reportRuns)
      .where(and(eq(schema.reportRuns.id, runId), eq(schema.reportRuns.machineId, machineId)));
    if (!full) return reply.code(404).send({ error: "run_not_found" });
    return reply.send({
      id: full.id,
      status: full.status,
      createdAt: full.createdAt,
      windowStart: full.windowStart,
      windowEnd: full.windowEnd,
      metrics: full.metrics,
      error: full.error,
      machineId: full.machineId,
      templateId: full.templateId,
      scheduleId: full.scheduleId,
      startedAt: full.startedAt,
      finishedAt: full.finishedAt,
    });
  });

  app.post("/reports/trigger", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.body as any)?.machineId ?? "");
    validateMachineAccess(machineId);

    const db = getPgDb();
    const boss = await tryGetBoss();
    if (!boss) return reply.code(500).send({ error: "queue_not_available" });

    // Ensure we have a template
    let template = (await db.select().from(schema.reportTemplates).limit(1))[0];
    if (!template) {
      const id = newId("template");
      await db.insert(schema.reportTemplates).values({
        id,
        name: "On-Demand Performance Report",
        description: "Generated by user",
        format: "html",
        definition: { kind: "alerts_summary" }
      });
      template = (await db.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.id, id)))[0];
    }
    if (!template) return reply.code(500).send({ error: "template_unavailable" });

    const windowEnd = new Date();
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24h

    const runId = newId("run");
    await db.insert(schema.reportRuns).values({
      id: runId,
      scheduleId: null,
      templateId: template.id,
      machineId,
      status: "queued",
      windowStart,
      windowEnd,
      metrics: {}
    });

    await boss.send(Jobs.reportRun, {
      runId,
      templateId: template.id,
      machineId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString()
    });

    try {
      const schemaName = config.queueSchema;
      const q = await db.execute(sql`select count(*)::int as count from ${sql.identifier(schemaName)}.job`);
      app.log.info({ machineId, queueJobs: (q as any).rows?.[0]?.count ?? null }, "report job enqueued");
    } catch {
      app.log.info({ machineId }, "report job enqueued");
    }
    reply.header("x-correlation-id", req.id);
    return reply.send({ ok: true, msg: "Report enqueued", runId });
  });

  /** Dev-only: enqueue report.run with explicit window (24h / 7d / 30d) for testing schedules without waiting. */
  app.post("/debug/reports/trigger", async (req, reply) => {
    requireApiAuth(req);
    if (config.nodeEnv === "production") return reply.code(403).send({ error: "forbidden_in_production" });
    const machineId = String((req.body as any)?.machineId ?? "");
    const windowKey = String((req.body as any)?.window ?? "24h").toLowerCase();
    if (!machineId) return reply.code(400).send({ error: "machineId_required" });
    validateMachineAccess(machineId);
    const hours =
      windowKey === "7d" ? 24 * 7 : windowKey === "30d" ? 24 * 30 : windowKey === "24h" ? 24 : 0;
    if (!hours) return reply.code(400).send({ error: "invalid_window", allowed: ["24h", "7d", "30d"] });

    const db = getPgDb();
    const boss = await tryGetBoss();
    if (!boss) return reply.code(500).send({ error: "queue_not_available" });

    let template = (await db.select().from(schema.reportTemplates).limit(1))[0];
    if (!template) {
      const id = newId("template");
      await db.insert(schema.reportTemplates).values({
        id,
        name: "On-Demand Performance Report",
        description: "Generated by debug trigger",
        format: "html",
        definition: { kind: "alerts_summary" }
      });
      template = (await db.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.id, id)))[0];
    }
    if (!template) return reply.code(500).send({ error: "template_unavailable" });

    const windowEnd = new Date();
    const windowStart = new Date(Date.now() - hours * 60 * 60 * 1000);
    const runId = newId("run");
    await db.insert(schema.reportRuns).values({
      id: runId,
      scheduleId: null,
      templateId: template.id,
      machineId,
      status: "queued",
      windowStart,
      windowEnd,
      metrics: { debugWindow: windowKey }
    });

    await boss.send(Jobs.reportRun, {
      runId,
      templateId: template.id,
      machineId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString()
    });

    reply.header("x-correlation-id", req.id);
    return reply.send({ ok: true, msg: "Report enqueued (debug window)", runId, window: windowKey });
  });

  app.get("/reports/view/:runId", async (req, reply) => {
    requireApiAuth(req);
    const runId = String((req.params as any)?.runId ?? "");
    if (!runId) return reply.code(400).send({ error: "runId_required" });
    const db = getPgDb();
    const artifact = (await db.select().from(schema.reportArtifacts).where(eq(schema.reportArtifacts.runId, runId)))[0];
    if (!artifact || !artifact.uri) return reply.code(404).send({ error: "report_not_found" });

    try {
      const content = await fs.readFile(artifact.uri, "utf8");
      return reply.type("text/html").send(content);
    } catch (err) {
      return reply.code(500).send({ error: "failed_to_read_report_file" });
    }
  });

  app.post("/smtp/test-email", async (req, reply) => {
    requireApiAuth(req);
    const target = String((req.body as any)?.to ?? config.reportEmailTo[0] ?? "");
    if (!target) return reply.code(400).send({ error: "recipient_required" });

    const verification = await verifySmtpTransport();
    if (!verification.ok) return reply.code(500).send(verification);

    const transport = getSmtpTransport();
    if (!transport) return reply.code(500).send({ ok: false, message: "failed_to_initialize_transport" });

    try {
      await transport.sendMail({
        from: smtpFromAddress("rvl-agent@localhost"),
        to: target,
        subject: "RVL Lamination Agent — SMTP Test Email",
        text: `Your Gmail setup is working! \n\nTime: ${new Date().toISOString()}\nMachine: ${config.machineId}`,
        html: `<h3>Your Gmail setup is working!</h3><p>Time: <strong>${new Date().toISOString()}</strong></p><p>Machine: <code>${config.machineId}</code></p>`
      });
      return reply.send({ ok: true, message: `Test email sent to ${target}` });
    } catch (err: any) {
      return reply.code(500).send({ ok: false, message: String(err?.message ?? err) });
    }
  });
}
