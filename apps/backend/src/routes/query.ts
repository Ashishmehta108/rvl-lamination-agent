import type { FastifyInstance } from "fastify";
import { requireApiAuth } from "../auth.js";
import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { desc, eq, and } from "drizzle-orm";

export async function registerQueryRoutes(app: FastifyInstance) {
  app.get("/tags/latest", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    if (!machineId) return reply.code(400).send({ error: "machineId_required" });
    const prisma = getMongoClient();
    const items = await prisma.tagLatest.findMany({ where: { machineId }, take: 500 });
    return reply.send({ items });
  });

  app.get("/alerts", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.query as any)?.machineId ?? "");
    const status = (req.query as any)?.status ? String((req.query as any).status) : undefined;
    if (!machineId) return reply.code(400).send({ error: "machineId_required" });
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
    if (!machineId) return reply.code(400).send({ error: "machineId_required" });
    const db = getPgDb();
    const items = await db
      .select()
      .from(schema.reportRuns)
      .where(eq(schema.reportRuns.machineId, machineId))
      .orderBy(desc(schema.reportRuns.createdAt))
      .limit(100);
    return reply.send({ items });
  });
}

