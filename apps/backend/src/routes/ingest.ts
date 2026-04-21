import type { FastifyInstance } from "fastify";
import { IngestBatchSchema, TagDefinitionSchema } from "@rvl/shared";
import { requireApiAuth } from "../auth.js";
import { cleanAndPersistBatch } from "../services/ingestService.js";
import { getMongoClient } from "@rvl/db-mongo";

export async function registerIngestRoutes(app: FastifyInstance) {
  app.put("/machines/:machineId/revisions/:machineRevision/definitions", async (req, reply) => {
    requireApiAuth(req);
    const machineId = String((req.params as any)?.machineId ?? "");
    const machineRevision = String((req.params as any)?.machineRevision ?? "");
    if (!machineId || !machineRevision) return reply.code(400).send({ error: "machineId_and_machineRevision_required" });

    const body = (req.body ?? {}) as any;
    const parsed = TagDefinitionSchema.array().safeParse(body.definitions ?? body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_definitions", issues: parsed.error.issues });
    }

    const prisma = getMongoClient();
    await prisma.machineProfile.upsert({
      where: { id: `${machineId}:${machineRevision}` },
      create: { id: `${machineId}:${machineRevision}`, machineId, machineRevision },
      update: {}
    });

    // Upsert each definition for this revision
    for (const d of parsed.data) {
      await prisma.tag.upsert({
        where: { id: d.tagId },
        create: {
          id: d.tagId,
          slug: d.slug,
          name: d.name,
          unit: d.unit,
          dataType: d.dataType,
          aliases: []
        },
        update: {
          slug: d.slug,
          name: d.name,
          unit: d.unit,
          dataType: d.dataType,
          department: d.department,
          engineerEmail: d.engineerEmail
        }
      });

      await prisma.tagDefinition.upsert({
        where: { id: `${machineId}:${machineRevision}:${d.tagId}` },
        create: {
          id: `${machineId}:${machineRevision}:${d.tagId}`,
          machineId,
          machineRevision,
          tagId: d.tagId,
          slug: d.slug,
          name: d.name,
          unit: d.unit,
          dataType: d.dataType,
          deadband: d.deadband,
          min: d.min,
          max: d.max,
          maxRatePerSec: d.maxRatePerSec,
          sampleEveryMs: d.sampleEveryMs,
          staleAfterMs: d.staleAfterMs,
          warnHigh: d.warnHigh,
          warnLow: d.warnLow,
          alarmHigh: d.alarmHigh,
          alarmLow: d.alarmLow,
          department: d.department,
          engineerEmail: d.engineerEmail
        },
        update: {
          slug: d.slug,
          name: d.name,
          unit: d.unit,
          dataType: d.dataType,
          deadband: d.deadband,
          min: d.min,
          max: d.max,
          maxRatePerSec: d.maxRatePerSec,
          sampleEveryMs: d.sampleEveryMs,
          staleAfterMs: d.staleAfterMs,
          warnHigh: d.warnHigh,
          warnLow: d.warnLow,
          alarmHigh: d.alarmHigh,
          alarmLow: d.alarmLow,
          department: d.department,
          engineerEmail: d.engineerEmail
        }
      });
    }

    return reply.send({ ok: true, count: parsed.data.length });
  });

  app.post("/ingest/tags", async (req, reply) => {
    requireApiAuth(req);
    const parsed = IngestBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const res = await cleanAndPersistBatch(parsed.data, app.log);
    return reply.send(res);
  });
}

