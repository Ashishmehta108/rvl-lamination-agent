import type PgBoss from "pg-boss";
import type { BaseLogger } from "pino";
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

export async function registerAlertDetectionWorker(boss: PgBoss, logger: BaseLogger) {
  logger.info({ job: Jobs.tagUpdated }, "worker registered");
  await boss.work<TagUpdatedPayload>(
    Jobs.tagUpdated,
    { teamConcurrency: 10 } as any,
    async (jobs: any) => {
      for (const job of jobs) {
        const { machineId, machineRevision, tagId, ts } = job.data as TagUpdatedPayload;
        const prisma = getMongoClient();
        const db = getPgDb();

        const def = await prisma.tagDefinition.findUnique({
          where: { id: `${machineId}:${machineRevision}:${tagId}` }
        });
        const latest = await prisma.tagLatest.findUnique({ where: { id: `${machineId}:${tagId}` } });

        if (!def || !latest) continue;
        if (def.dataType !== "number") continue;
        if (typeof latest.valueNumber !== "number") continue;

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

        if (triggers.length === 0) continue;

        const primary = triggers.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "alarm" ? -1 : 1))[0]!;
        const severity = computeSeverity(primary.kind);
        const dedupeKey = `${machineId}:${machineRevision}:${tagId}:${primary.kind}:${primary.side}`;

        try {
          const alertId = newId("alert");
          const deliveryTargets: Array<{ deliveryId: string }> = [];

          await db.transaction(async (tx) => {
            await tx.insert(schema.alertEvents).values({
              id: alertId,
              machineId,
              ruleId: null,
              severity,
              status: "open",
              title: `${def.name} ${primary.kind.toUpperCase()} (${primary.side})`,
              description: `${def.name} (${def.slug}): value ${v} ${def.unit ?? ""} exceeded ${primary.kind} ${primary.side} limit (threshold ${primary.threshold}). [rule:threshold_breach]`,
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

            await tx.insert(schema.alertTags).values({
              alertEventId: alertId,
              tagId,
              tagSnapshot: { tagId, slug: def.slug, name: def.name, unit: def.unit, department: def.department }
            });

            if (def.engineerEmail) {
              const deliveryId = newId("delivery");
              const idempotencyKey = `email:${alertId}:${def.engineerEmail}`;
              await tx.insert(schema.alertDeliveries).values({
                id: deliveryId,
                alertEventId: alertId,
                channel: "email",
                destination: def.engineerEmail,
                status: "queued",
                attempt: 0,
                idempotencyKey
              });
              deliveryTargets.push({ deliveryId });
            }
          });

          logger.info({ alertId, machineId, tagId, severity }, "alert created");
          for (const d of deliveryTargets) {
            try {
              await boss.send(Jobs.alertDeliver, d);
            } catch (err) {
              logger.error({ err: String(err), ...d }, "failed to enqueue alert delivery");
            }
          }
        } catch (err: any) {
          logger.debug({ err: String(err) }, "alert deduped/ignored");
        }
      }
    }
  );
}


