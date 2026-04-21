import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import { getMongoClient } from "@rvl/db-mongo";
import { getPgDb, schema } from "@rvl/db-postgres";
import { newId } from "@rvl/shared";
import { Jobs } from "./jobs.js";

type TagUpdatedPayload = {
  machineId: string;
  machineRevision: string;
  tagId: string;
  ts: string;
};

function computeSeverity(kind: "warn" | "alarm") {
  return kind === "alarm" ? "critical" : "warning";
}

export async function registerAlertDetectionWorker(boss: PgBoss, logger: Logger) {
  await boss.work<TagUpdatedPayload>(Jobs.tagUpdated, { teamSize: 1, teamConcurrency: 10 }, async (job) => {
    const { machineId, machineRevision, tagId, ts } = job.data;
    const prisma = getMongoClient();
    const db = getPgDb();

    const def = await prisma.tagDefinition.findUnique({
      where: { id: `${machineId}:${machineRevision}:${tagId}` }
    });
    const latest = await prisma.tagLatest.findUnique({ where: { id: `${machineId}:${tagId}` } });

    if (!def || !latest) return;
    if (def.dataType !== "number") return;
    if (typeof latest.valueNumber !== "number") return;

    const v = latest.valueNumber;
    const now = new Date(ts);

    const triggers: Array<{ kind: "warn" | "alarm"; side: "high" | "low"; threshold: number }> = [];

    if (def.alarmHigh !== null && def.alarmHigh !== undefined && v >= def.alarmHigh) {
      triggers.push({ kind: "alarm", side: "high", threshold: def.alarmHigh });
    } else if (def.warnHigh !== null && def.warnHigh !== undefined && v >= def.warnHigh) {
      triggers.push({ kind: "warn", side: "high", threshold: def.warnHigh });
    }

    if (def.alarmLow !== null && def.alarmLow !== undefined && v <= def.alarmLow) {
      triggers.push({ kind: "alarm", side: "low", threshold: def.alarmLow });
    } else if (def.warnLow !== null && def.warnLow !== undefined && v <= def.warnLow) {
      triggers.push({ kind: "warn", side: "low", threshold: def.warnLow });
    }

    if (triggers.length === 0) return;

    const primary = triggers.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "alarm" ? -1 : 1))[0]!;
    const severity = computeSeverity(primary.kind);
    const dedupeKey = `${machineId}:${machineRevision}:${tagId}:${primary.kind}:${primary.side}`;

    // Idempotent create: unique(machineId, dedupeKey) in schema.
    // If it already exists, we treat it as "still active" and do nothing.
    try {
      const alertId = newId("alert");

      await db.insert(schema.alertEvents).values({
        id: alertId,
        machineId,
        ruleId: null,
        severity,
        status: "open",
        title: `${def.name} ${primary.kind.toUpperCase()} (${primary.side})`,
        description: `${def.slug}: ${v} ${def.unit ?? ""} crossed ${primary.side} threshold ${primary.threshold}`,
        dedupeKey,
        payload: {
          tagId,
          tagSlug: def.slug,
          value: v,
          ts: latest.ts.toISOString(),
          threshold: primary.threshold,
          kind: primary.kind,
          side: primary.side
        },
        startsAt: now
      });

      await db.insert(schema.alertTags).values({
        alertEventId: alertId,
        tagId,
        tagSnapshot: { tagId, slug: def.slug, name: def.name, unit: def.unit, department: def.department }
      });

      logger.info({ alertId, machineId, tagId, severity }, "alert created");

      // enqueue delivery attempts if we have a mapped engineer
      if (def.engineerEmail) {
        const deliveryId = newId("delivery");
        const idempotencyKey = `email:${alertId}:${def.engineerEmail}`;
        await db.insert(schema.alertDeliveries).values({
          id: deliveryId,
          alertEventId: alertId,
          channel: "email",
          destination: def.engineerEmail,
          status: "queued",
          attempt: 0,
          idempotencyKey
        });
        await boss.send(Jobs.alertDeliver, { deliveryId });
      }
    } catch (err: any) {
      // Unique violation => existing open alert with same dedupeKey already exists.
      logger.debug({ err: String(err) }, "alert deduped/ignored");
    }
  });
}

