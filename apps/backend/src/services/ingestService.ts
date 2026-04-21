import type { BaseLogger } from "pino";
import { getMongoClient } from "@rvl/db-mongo";
import { newId } from "@rvl/shared";
import type { IngestBatch, IngestResponse } from "@rvl/shared";
import { tryGetBoss } from "../queue/boss.js";
import { Jobs } from "../workers/jobs.js";

type CleanQuality = "good" | "bad";

function coerceValue(input: unknown, dataType: string): { ok: boolean; value: any; reason?: string } {
  if (input === null) return { ok: true, value: null };
  if (dataType === "number") {
    if (typeof input === "number") return { ok: true, value: input };
    if (typeof input === "boolean") return { ok: true, value: input ? 1 : 0 };
    if (typeof input === "string" && input.trim() !== "") {
      const n = Number(input);
      if (!Number.isNaN(n)) return { ok: true, value: n };
    }
    return { ok: false, value: null, reason: "type_coercion_failed" };
  }
  if (dataType === "boolean") {
    if (typeof input === "boolean") return { ok: true, value: input };
    if (typeof input === "number") return { ok: true, value: input !== 0 };
    if (typeof input === "string") {
      const s = input.toLowerCase().trim();
      if (s === "true" || s === "1") return { ok: true, value: true };
      if (s === "false" || s === "0") return { ok: true, value: false };
    }
    return { ok: false, value: null, reason: "type_coercion_failed" };
  }
  if (dataType === "string") {
    if (typeof input === "string") return { ok: true, value: input };
    if (typeof input === "number" || typeof input === "boolean") return { ok: true, value: String(input) };
    return { ok: false, value: null, reason: "type_coercion_failed" };
  }
  return { ok: false, value: null, reason: "unknown_data_type" };
}

function isOutOfOrder(prevTs: Date | null, nextTs: Date): boolean {
  if (!prevTs) return false;
  return nextTs.getTime() < prevTs.getTime();
}

function numericQualityChecks(args: {
  value: number;
  prevValue: number | null;
  dtSec: number | null;
  min?: number | null;
  max?: number | null;
  maxRatePerSec?: number | null;
}): { quality: CleanQuality; reasons: string[] } {
  const reasons: string[] = [];
  let quality: CleanQuality = "good";

  if (args.min !== null && args.min !== undefined && args.value < args.min) {
    quality = "bad";
    reasons.push("below_min");
  }
  if (args.max !== null && args.max !== undefined && args.value > args.max) {
    quality = "bad";
    reasons.push("above_max");
  }

  if (
    args.prevValue !== null &&
    args.prevValue !== undefined &&
    args.dtSec !== null &&
    args.dtSec > 0 &&
    args.maxRatePerSec !== null &&
    args.maxRatePerSec !== undefined
  ) {
    const rate = Math.abs(args.value - args.prevValue) / args.dtSec;
    if (rate > args.maxRatePerSec) {
      quality = "bad";
      reasons.push("rate_of_change");
    }
  }

  return { quality, reasons };
}

export async function cleanAndPersistBatch(batch: IngestBatch, logger: any): Promise<IngestResponse> {
  const prisma = getMongoClient();
  const boss = await tryGetBoss();

  let accepted = 0;
  let rejected = 0;
  const perTag: IngestResponse["perTag"] = [];

  // Ensure profile exists (machineId+revision)
  await prisma.machineProfile.upsert({
    where: { id: `${batch.machineId}:${batch.machineRevision}` },
    create: {
      id: `${batch.machineId}:${batch.machineRevision}`,
      machineId: batch.machineId,
      machineRevision: batch.machineRevision
    },
    update: {}
  });

  // Per-machine ingest state (seq monotonic-ish)
  const ingestStateId = `${batch.machineId}:${batch.machineRevision}`;
  const ingestState = await prisma.machineIngestState.findUnique({ where: { id: ingestStateId } });
  if (ingestState && batch.seq < ingestState.lastSeq) {
    // Likely replay/reset. Accept but do not regress state; tag-level out-of-order is still enforced.
    logger.warn(
      { machineId: batch.machineId, machineRevision: batch.machineRevision, seq: batch.seq, lastSeq: ingestState.lastSeq },
      "ingest seq regressed (possible replay/reset)"
    );
  } else {
    await prisma.machineIngestState.upsert({
      where: { id: ingestStateId },
      create: {
        id: ingestStateId,
        machineId: batch.machineId,
        machineRevision: batch.machineRevision,
        lastSeq: batch.seq,
        lastSentAt: batch.sentAt
      },
      update: {
        lastSeq: batch.seq,
        lastSentAt: batch.sentAt
      }
    });
  }

  // Pull tag definitions for this revision (fast path)
  const defs = await prisma.tagDefinition.findMany({
    where: { machineId: batch.machineId, machineRevision: batch.machineRevision }
  });
  const defsByTagId = new Map(defs.map((d) => [d.tagId, d]));
  const defsBySlug = new Map(defs.map((d) => [d.slug, d]));

  for (const t of batch.tags) {
    try {
      const ts = t.ts ?? batch.sentAt;
      const def = t.tagId ? defsByTagId.get(t.tagId) : t.tagSlug ? defsBySlug.get(t.tagSlug) : undefined;

      // If unknown tag, create a minimal Tag + TagDefinition for this machine revision.
      // This makes ingestion resilient during commissioning while still preserving machineRevision boundaries.
      let tagId = def?.tagId ?? t.tagId ?? newId("tag");
      let tagSlug = def?.slug ?? t.tagSlug ?? tagId;
      let dataType = def?.dataType ?? "number";

      if (!def) {
        await prisma.tag.upsert({
          where: { id: tagId },
          create: {
            id: tagId,
            slug: tagSlug,
            name: tagSlug,
            aliases: []
          },
          update: {
            slug: tagSlug,
            name: tagSlug
          }
        });
        await prisma.tagDefinition.upsert({
          where: { id: `${batch.machineId}:${batch.machineRevision}:${tagId}` },
          create: {
            id: `${batch.machineId}:${batch.machineRevision}:${tagId}`,
            machineId: batch.machineId,
            machineRevision: batch.machineRevision,
            tagId,
            slug: tagSlug,
            name: tagSlug,
            dataType
          },
          update: {}
        });
      } else {
        tagId = def.tagId;
        tagSlug = def.slug;
        dataType = def.dataType;
      }

      const coerced = coerceValue(t.value, dataType);
      if (!coerced.ok) {
        rejected++;
        perTag.push({ tagId, tagSlug, status: "rejected", reason: coerced.reason });
        continue;
      }

      const latestId = `${batch.machineId}:${tagId}`;
      const prevLatest = await prisma.tagLatest.findUnique({ where: { id: latestId } });
      if (prevLatest && isOutOfOrder(prevLatest.ts, ts)) {
        rejected++;
        perTag.push({ tagId, tagSlug, status: "rejected", reason: "out_of_order" });
        continue;
      }

      let quality: CleanQuality = "good";
      const reasons: string[] = [];

      if (dataType === "number" && typeof coerced.value === "number") {
        const prevValue = typeof prevLatest?.valueNumber === "number" ? prevLatest.valueNumber : null;
        const dtSec =
          prevLatest?.ts && ts
            ? Math.max(0, (ts.getTime() - prevLatest.ts.getTime()) / 1000)
            : null;

        const checked = numericQualityChecks({
          value: coerced.value,
          prevValue,
          dtSec,
          min: def?.min ?? null,
          max: def?.max ?? null,
          maxRatePerSec: def?.maxRatePerSec ?? null
        });
        quality = checked.quality;
        reasons.push(...checked.reasons);

        if (def?.deadband !== null && def?.deadband !== undefined && prevValue !== null) {
          if (Math.abs(coerced.value - prevValue) <= def.deadband) {
            // Dedupe within deadband: update latest timestamp, but avoid sampling.
            await prisma.tagLatest.upsert({
              where: { id: latestId },
              create: {
                id: latestId,
                machineId: batch.machineId,
                tagId,
                ts,
                valueNumber: coerced.value,
                quality: quality === "good" ? "good" : "bad"
              },
              update: {
                ts,
                valueNumber: coerced.value,
                quality: quality === "good" ? "good" : "bad"
              }
            });

            accepted++;
            perTag.push({ tagId, tagSlug, status: "accepted" });
            continue;
          }
        }
      }

      // Persist latest
      const latestCreate: any = {
        id: latestId,
        machineId: batch.machineId,
        tagId,
        ts,
        quality: quality === "good" ? "good" : "bad"
      };
      const latestUpdate: any = {
        ts,
        quality: quality === "good" ? "good" : "bad"
      };

      if (dataType === "number") {
        latestCreate.valueNumber = typeof coerced.value === "number" ? coerced.value : undefined;
        latestUpdate.valueNumber = typeof coerced.value === "number" ? coerced.value : undefined;
      } else if (dataType === "boolean") {
        latestCreate.valueBool = typeof coerced.value === "boolean" ? coerced.value : undefined;
        latestUpdate.valueBool = typeof coerced.value === "boolean" ? coerced.value : undefined;
      } else {
        latestCreate.valueString = typeof coerced.value === "string" ? coerced.value : undefined;
        latestUpdate.valueString = typeof coerced.value === "string" ? coerced.value : undefined;
      }

      // Sampling policy
      const sampleEveryMs = def?.sampleEveryMs ?? null;
      let shouldSample = true;
      if (sampleEveryMs) {
        const lastSampleAt = prevLatest?.lastSampleAt ?? null;
        if (lastSampleAt && ts.getTime() - lastSampleAt.getTime() < sampleEveryMs) {
          shouldSample = false;
        }
      }

      if (shouldSample) {
        await prisma.tagSample.create({
          data: {
            id: newId("tag"),
            machineId: batch.machineId,
            tagId,
            ts,
            valueNumber: dataType === "number" ? coerced.value ?? undefined : undefined,
            valueBool: dataType === "boolean" ? coerced.value ?? undefined : undefined,
            valueString: dataType === "string" ? coerced.value ?? undefined : undefined,
            quality: quality === "good" ? "good" : "bad"
          }
        });
        latestUpdate.lastSampleAt = ts;
        latestCreate.lastSampleAt = ts;
      }

      await prisma.tagLatest.upsert({
        where: { id: latestId },
        create: latestCreate,
        update: latestUpdate
      });

      if (boss) {
        await boss.send(Jobs.tagUpdated, {
          machineId: batch.machineId,
          machineRevision: batch.machineRevision,
          tagId,
          ts: ts.toISOString()
        });
      }

      accepted++;
      perTag.push({
        tagId,
        tagSlug,
        status: "accepted",
        reason: reasons.length ? reasons.join(",") : undefined
      });
    } catch (err) {
      rejected++;
      logger.warn({ err }, "ingest tag rejected");
      perTag.push({ tagId: t.tagId, tagSlug: t.tagSlug, status: "rejected", reason: "persist_failed" });
    }
  }

  logger.debug({ accepted, rejected, machineId: batch.machineId }, "ingest batch processed");
  return { accepted, rejected, perTag };
}

