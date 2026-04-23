import type { FastifyInstance } from "fastify";
import { IngestBatchSchema, TagDefinitionSchema } from "@rvl/shared";
import { requireApiAuth } from "../auth.js";
import { cleanAndPersistBatch } from "../services/ingestService.js";
import { getNativeDb } from "@rvl/db-mongo";

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

    const db = await getNativeDb();
    const machineProfiles = db.collection<any>("MachineProfile");
    const tags = db.collection<any>("Tag");
    const tagDefinitions = db.collection<any>("TagDefinition");

    const profileId = `${machineId}:${machineRevision}`;
    await machineProfiles.updateOne(
      { _id: profileId },
      { $set: { machineId, machineRevision, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    // Upsert each definition for this revision
    for (const d of parsed.data) {
      const tagData = {
        slug: d.slug,
        name: d.name,
        unit: d.unit,
        dataType: d.dataType,
        department: d.department,
        engineerEmail: d.engineerEmail,
        updatedAt: new Date()
      };
      
      await tags.updateOne(
        { _id: d.tagId },
        { $set: tagData, $setOnInsert: { createdAt: new Date(), aliases: [] } },
        { upsert: true }
      );

      const defId = `${machineId}:${machineRevision}:${d.tagId}`;
      const defData = {
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
        engineerEmail: d.engineerEmail,
        updatedAt: new Date()
      };

      await tagDefinitions.updateOne(
        { _id: defId },
        { $set: defData, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
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
