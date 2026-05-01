import type { BaseLogger } from "pino";
import { getMongoClient, getNativeDb } from "@rvl/db-mongo";
import { newId } from "@rvl/shared";
import type { IngestBatch, IngestResponse } from "@rvl/shared";
import { tryGetBoss } from "../queue/boss.js";
import { Jobs } from "../workers/jobs.js";
import { mlCollectAndPredict } from "./mlService.js";

type CleanQuality = "good" | "bad";

type Def = {
  tagId: string;
  slug: string;
  name?: string;
  dataType?: string;
  deadband?: number | null;
  min?: number | null;
  max?: number | null;
  maxRatePerSec?: number | null;
  sampleEveryMs?: number | null;
  warnHigh?: number | null;
  warnLow?: number | null;
  alarmHigh?: number | null;
  alarmLow?: number | null;
};

const defsCache = new Map<
  string,
  { expiresAt: number; defsByTagId: Map<string, Def>; defsBySlug: Map<string, Def> }
>();

async function getDefsForProfile(args: {
  tagDefinitions: any;
  machineId: string;
  machineRevision: string;
  nowMs: number;
}): Promise<{ defsByTagId: Map<string, Def>; defsBySlug: Map<string, Def> }> {
  const key = `${args.machineId}:${args.machineRevision}`;
  const cached = defsCache.get(key);
  if (cached && cached.expiresAt > args.nowMs) return cached;

  const defs = (await args.tagDefinitions
    .find({ machineId: args.machineId, machineRevision: args.machineRevision })
    .toArray()) as Def[];
  const defsByTagId = new Map(defs.map((d) => [d.tagId, d]));
  const defsBySlug = new Map<string, Def>();
  const score = (d: Def) => {
    // Prefer definitions that have thresholds and bounds (seeded defs),
    // then prefer tagId==slug, then most metadata overall.
    let s = 0;
    if (d.alarmHigh != null || d.alarmLow != null || d.warnHigh != null || d.warnLow != null) s += 50;
    if (d.min != null || d.max != null) s += 10;
    if (d.tagId === d.slug) s += 5;
    if (d.deadband != null) s += 1;
    if (d.sampleEveryMs != null) s += 1;
    return s;
  };
  for (const d of defs) {
    if (!d?.slug) continue;
    const prev = defsBySlug.get(d.slug);
    if (!prev || score(d) > score(prev)) {
      defsBySlug.set(d.slug, d);
    }
  }
  const next = { expiresAt: args.nowMs + 30_000, defsByTagId, defsBySlug };
  defsCache.set(key, next);
  return next;
}

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
  const db = await getNativeDb();
  const boss = await tryGetBoss();

  let accepted = 0;
  let rejected = 0;
  const perTag: IngestResponse["perTag"] = [];

  const machineProfiles = db.collection<any>("MachineProfile");
  const machineIngestStates = db.collection<any>("MachineIngestState");
  const tags = db.collection<any>("Tag");
  const tagDefinitions = db.collection<any>("TagDefinition");
  const tagLatests = db.collection<any>("TagLatest");
  const tagSamples = db.collection<any>("TagSample");

  const profileId = `${batch.machineId}:${batch.machineRevision}`;
  await machineProfiles.updateOne(
    { _id: profileId },
    { $set: { machineId: batch.machineId, machineRevision: batch.machineRevision, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  const ingestStateId = `${batch.machineId}:${batch.machineRevision}`;
  const ingestState = await machineIngestStates.findOne({ _id: ingestStateId });
  if (!ingestState) {
    await machineIngestStates.updateOne(
      { _id: ingestStateId },
      {
        $set: {
          machineId: batch.machineId,
          machineRevision: batch.machineRevision,
          lastSeq: batch.seq,
          lastSentAt: batch.sentAt,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  } else {
    const updateRes = await machineIngestStates.updateOne(
      { _id: ingestStateId, lastSeq: { $lt: batch.seq } },
      {
        $set: {
          lastSeq: batch.seq,
          lastSentAt: batch.sentAt,
          updatedAt: new Date()
        }
      }
    );
    if (updateRes.modifiedCount === 0) {
      // Some simulators restart seq from 1 on process restart. If timestamps move
      // forward and the seq looks like a fresh counter, accept the reset.
      const lastSeq = Number(ingestState.lastSeq ?? -1);
      const incomingSeq = Number(batch.seq ?? -1);
      const lastSentAt = ingestState.lastSentAt ? new Date(ingestState.lastSentAt) : null;
      const incomingSentAt = batch.sentAt instanceof Date ? batch.sentAt : new Date(batch.sentAt as any);
      const newerStream = lastSentAt ? incomingSentAt.getTime() > lastSentAt.getTime() + 5000 : true;
      const looksLikeSeqReset =
        Number.isFinite(lastSeq) &&
        Number.isFinite(incomingSeq) &&
        incomingSeq >= 0 &&
        incomingSeq < lastSeq &&
        incomingSeq <= 100 &&
        lastSeq - incomingSeq >= 10;

      if (looksLikeSeqReset && newerStream) {
        await machineIngestStates.updateOne(
          { _id: ingestStateId },
          {
            $set: {
              lastSeq: incomingSeq,
              lastSentAt: batch.sentAt,
              updatedAt: new Date()
            }
          }
        );
        logger.warn(
          {
            machineId: batch.machineId,
            machineRevision: batch.machineRevision,
            prevSeq: ingestState.lastSeq ?? null,
            resetSeq: incomingSeq
          },
          "ingest_seq_reset_accepted"
        );
      } else {
      logger.warn(
        { machineId: batch.machineId, machineRevision: batch.machineRevision, seq: batch.seq, lastSeq: ingestState.lastSeq ?? null },
        "stale_ingest_seq_batch_ignored"
      );
      for (const t of batch.tags) {
        perTag.push({ tagId: t.tagId, tagSlug: t.tagSlug, status: "rejected", reason: "stale_seq" });
      }
      return { accepted: 0, rejected: batch.tags.length, perTag };
      }
    }
  }

  const nowMs = Date.now();
  const { defsByTagId, defsBySlug } = await getDefsForProfile({
    tagDefinitions,
    machineId: batch.machineId,
    machineRevision: batch.machineRevision,
    nowMs
  });

  // Preload latest values for all tags in this batch to avoid per-tag RTT
  const latestIds = batch.tags.map((t) => `${batch.machineId}:${t.tagId ?? (t.tagSlug ?? "")}`).filter((s) => s.includes(":") && !s.endsWith(":"));
  const prevLatests = latestIds.length ? await tagLatests.find({ _id: { $in: latestIds } }).toArray() : [];
  const prevLatestById = new Map(prevLatests.map((d: any) => [d._id, d]));

  const latestOps: any[] = [];
  const sampleDocs: any[] = [];

  for (const t of batch.tags) {
    try {
      const ts = t.ts ?? batch.sentAt;
      const def = t.tagId ? defsByTagId.get(t.tagId) : t.tagSlug ? defsBySlug.get(t.tagSlug) : undefined;

      let tagId = def?.tagId ?? t.tagId ?? newId("tag");
      let tagSlug = def?.slug ?? t.tagSlug ?? tagId;
      let dataType = def?.dataType ?? "number";

      if (!def) {
        await tags.updateOne(
          { _id: tagId },
          { $set: { slug: tagSlug, name: tagSlug, aliases: [], updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
          { upsert: true }
        );
        const defId = `${batch.machineId}:${batch.machineRevision}:${tagId}`;
        await tagDefinitions.updateOne(
          { _id: defId },
          { $set: { machineId: batch.machineId, machineRevision: batch.machineRevision, tagId, slug: tagSlug, name: tagSlug, dataType, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
          { upsert: true }
        );
      } else {
        tagId = def.tagId;
        tagSlug = def.slug;
        dataType = def.dataType ?? "number";
      }

      const coerced = coerceValue(t.value, dataType);
      if (!coerced.ok) { rejected++; perTag.push({ tagId, tagSlug, status: "rejected", reason: coerced.reason }); continue; }

      const latestId = `${batch.machineId}:${tagId}`;
      const prevLatest = prevLatestById.get(latestId) ?? null;
      if (prevLatest && isOutOfOrder(prevLatest.ts, ts)) { rejected++; perTag.push({ tagId, tagSlug, status: "rejected", reason: "out_of_order" }); continue; }

      let quality: CleanQuality = "good";
      const reasons: string[] = [];

      if (dataType === "number" && typeof coerced.value === "number") {
        const prevValue = typeof prevLatest?.valueNumber === "number" ? prevLatest.valueNumber : null;
        const dtSec = prevLatest?.ts && ts ? Math.max(0, (ts.getTime() - prevLatest.ts.getTime()) / 1000) : null;
        const checked = numericQualityChecks({ value: coerced.value, prevValue, dtSec, min: def?.min ?? null, max: def?.max ?? null, maxRatePerSec: def?.maxRatePerSec ?? null });
        quality = checked.quality; reasons.push(...checked.reasons);

        if (def?.deadband !== null && def?.deadband !== undefined && prevValue !== null) {
          if (Math.abs(coerced.value - prevValue) <= def.deadband) {
            const latestUpdate = {
              machineId: batch.machineId,
              tagId,
              ts,
              valueNumber: coerced.value,
              quality: quality === "good" ? "good" : "bad",
              updatedAt: new Date()
            };
            latestOps.push({ updateOne: { filter: { _id: latestId }, update: { $set: latestUpdate }, upsert: true } });
            prevLatestById.set(latestId, { _id: latestId, ...latestUpdate });
            accepted++; perTag.push({ tagId, tagSlug, status: "accepted" }); continue;
          }
        }
      }

      const latestUpdate: any = { machineId: batch.machineId, tagId, ts, quality: quality === "good" ? "good" : "bad", updatedAt: new Date() };
      if (dataType === "number") latestUpdate.valueNumber = coerced.value;
      else if (dataType === "boolean") latestUpdate.valueBool = coerced.value;
      else latestUpdate.valueString = coerced.value;

      const sampleEveryMs = def?.sampleEveryMs ?? null;
      let shouldSample = true;
      if (sampleEveryMs && prevLatest?.lastSampleAt && ts.getTime() - prevLatest.lastSampleAt.getTime() < sampleEveryMs) shouldSample = false;

      if (shouldSample) {
        sampleDocs.push({
          _id: newId("tag"),
          machineId: batch.machineId,
          tagId,
          ts,
          valueNumber: dataType === "number" ? coerced.value : undefined,
          valueBool: dataType === "boolean" ? coerced.value : undefined,
          valueString: dataType === "string" ? coerced.value : undefined,
          quality: quality === "good" ? "good" : "bad"
        });
        latestUpdate.lastSampleAt = ts;
      }

      latestOps.push({ updateOne: { filter: { _id: latestId }, update: { $set: latestUpdate }, upsert: true } });
      prevLatestById.set(latestId, { _id: latestId, ...latestUpdate });
      if (boss) await boss.send(Jobs.tagUpdated, { machineId: batch.machineId, machineRevision: batch.machineRevision, tagId, ts: ts.toISOString() });
      accepted++; perTag.push({ tagId, tagSlug, status: "accepted", reason: reasons.length ? reasons.join(",") : undefined });
    } catch (err) {
      rejected++; logger.warn({ err }, "ingest tag rejected");
      perTag.push({ tagId: t.tagId, tagSlug: t.tagSlug, status: "rejected", reason: "persist_failed" });
    }
  }

  // Persist batched writes last (reduces total RTT dramatically)
  if (sampleDocs.length) {
    try {
      await tagSamples.insertMany(sampleDocs, { ordered: false });
    } catch (err) {
      logger.warn({ err: String(err), count: sampleDocs.length }, "tagSamples insertMany failed (partial possible)");
    }
  }
  if (latestOps.length) {
    await tagLatests.bulkWrite(latestOps, { ordered: false });
  }

  logger.debug({ accepted, rejected, machineId: batch.machineId }, "ingest batch processed");

  // ── ML pipeline: collect + predict (non-blocking) ────────────
  // Build a flat tag map from the accepted tags in this batch
  if (accepted > 0) {
    const mlTags: Record<string, unknown> = {};
    for (const t of batch.tags) {
      const slug = t.tagSlug ?? t.tagId;
      if (slug && t.value !== null && t.value !== undefined) {
        mlTags[slug] = t.value;
      }
    }
    if (Object.keys(mlTags).length > 0) {
      const ts = batch.sentAt instanceof Date
        ? batch.sentAt.toISOString()
        : String(batch.sentAt);
      // Fire-and-forget: never blocks ingest response
      void mlCollectAndPredict(ts, mlTags).then((result) => {
        if (result?.is_anomaly) {
          logger.warn(
            {
              machineId: batch.machineId,
              mlScore: result.score,
              anomalousTags: result.anomalous_tags,
              alertId: result.alert_id ?? null,
            },
            "ml_anomaly_detected"
          );
        }
      }).catch(() => {
        // ML server offline — silently skip
      });
    }
  }

  return { accepted, rejected, perTag };
}
