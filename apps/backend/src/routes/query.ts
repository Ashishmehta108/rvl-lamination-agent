import type { FastifyInstance } from "fastify";
import { requireApiAuth, validateMachineAccess } from "../auth.js";
import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { desc, eq, and, sql } from "drizzle-orm";
import { newId } from "@rvl/shared";
import { tryGetBoss } from "../queue/boss.js";
import { Jobs } from "../workers/jobs.js";
import fs from "node:fs/promises";
import { config } from "../config.js";

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
    const items = await prisma.tagLatest.findMany({ where: { machineId }, take: 500 });

    // Fetch definitions for this machine to get human-readable slugs/names
    const definitions = await prisma.tagDefinition.findMany({
      where: { machineId },
      select: { tagId: true, slug: true, name: true }
    });

    const defMap = new Map(definitions.map(d => [d.tagId, d]));

    const enhancedItems = items.map(item => ({
      ...item,
      slug: defMap.get(item.tagId)?.slug || item.tagId,
      name: defMap.get(item.tagId)?.name || item.tagId,
    }));

    return reply.send({ items: enhancedItems });
  });

  app.get("/alerts", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    const status = (req.query as any)?.status ? String((req.query as any).status) : undefined;
    validateMachineAccess(machineId);
    const db = getPgDb();
    const where = status
      ? and(eq(schema.alertEvents.machineId, machineId), eq(schema.alertEvents.status, status as any))
      : eq(schema.alertEvents.machineId, machineId);
    const items = await db.select().from(schema.alertEvents).where(where).orderBy(desc(schema.alertEvents.startsAt)).limit(200);
    return reply.send({ items });
  });

  app.get("/reports/runs", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    validateMachineAccess(machineId);
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
      .limit(10);
    return reply.send({ items });
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
    return reply.send({ ok: true, msg: "Report enqueued", runId });
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
}
