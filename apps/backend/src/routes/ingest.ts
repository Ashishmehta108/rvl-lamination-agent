import type { FastifyInstance } from "fastify";
import { IngestBatchSchema, TagDefinitionSchema } from "@rvl/shared";
import { requireApiAuth } from "../auth.js";
import { cleanAndPersistBatch } from "../services/ingestService.js";
import { getNativeDb } from "@rvl/db-mongo";

function toIso(input: unknown, fallback: Date): string {
  if (input instanceof Date) return input.toISOString();
  if (typeof input === "string" && input.trim() !== "") return input;
  return fallback.toISOString();
}

function normalizeIngestBody(body: any, fallbackMachineId: string, fallbackMachineRevision: string) {
  const strict = IngestBatchSchema.safeParse(body);
  if (strict.success) return strict.data;

  const now = new Date();
  const machineId = String(body?.machineId ?? fallbackMachineId).trim();
  const machineRevision = String(body?.machineRevision ?? fallbackMachineRevision).trim();
  const sentAt = toIso(body?.sentAt, now);
  const seqCandidate = Number(body?.seq);
  const seq = Number.isFinite(seqCandidate) ? seqCandidate : Date.now();

  const rawTags = body?.tags ?? body;
  const tags: Array<{ tagSlug: string; value: unknown; ts: string }> = [];

  if (rawTags && typeof rawTags === "object" && !Array.isArray(rawTags)) {
    for (const [tagSlug, rawVal] of Object.entries(rawTags)) {
      if (!tagSlug) continue;
      const value =
        rawVal && typeof rawVal === "object" && "value" in (rawVal as Record<string, unknown>)
          ? (rawVal as Record<string, unknown>).value
          : rawVal;
      const ts =
        rawVal && typeof rawVal === "object" && "ts" in (rawVal as Record<string, unknown>)
          ? toIso((rawVal as Record<string, unknown>).ts, now)
          : sentAt;
      tags.push({ tagSlug, value, ts });
    }
  }

  return IngestBatchSchema.parse({
    machineId,
    machineRevision,
    sentAt,
    seq,
    tags
  });
}

export async function registerIngestRoutes(app: FastifyInstance) {
  app.put("/machines/:machineId/revisions/:machineRevision/definitions", async (req, reply) => {
    // requireApiAuth(req);
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
    // requireApiAuth(req);
    const fallbackMachineId = String(req.headers["x-machine-id"] ?? "lamination-01");
    const fallbackMachineRevision = String(req.headers["x-machine-revision"] ?? "v1");

    let batch;
    try {
      batch = normalizeIngestBody(req.body, fallbackMachineId, fallbackMachineRevision);
      console.log(batch)
    } catch (err: any) {
      return reply.code(400).send({
        error: "invalid_request",
        detail: String(err?.message ?? err)
      });
    }

    const res = await cleanAndPersistBatch(batch, app.log);
    return reply.send(res);
  });
}
