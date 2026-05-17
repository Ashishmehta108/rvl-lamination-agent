import type PgBoss from "pg-boss";
import type { BaseLogger } from "pino";
import { and, eq, inArray } from "drizzle-orm";
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

type Trigger = { kind: "warn" | "alarm"; side: "high" | "low"; threshold: number };

type AlertPayload = {
  tagId?: string;
  tagSlug?: string;
  value?: number;
  ts?: string;
  threshold?: number;
  kind?: "warn" | "alarm";
  side?: "high" | "low";
  resolution?: Record<string, unknown>;
};

function computeSeverity(kind: "warn" | "alarm") {
  return kind === "alarm" ? "critical" : "warning";
}

function breachDescription(
  def: { name: string; slug: string; unit: string | null },
  v: number,
  primary: Trigger
) {
  return `${def.name} (${def.slug}): value ${v} ${def.unit ?? ""} exceeded ${primary.kind} ${primary.side} limit (threshold ${primary.threshold}). [rule:threshold_breach]`;
}

function buildClearReason(
  tagName: string,
  unit: string | null | undefined,
  value: number,
  clearedKind: "warn" | "alarm",
  clearedSide: "high" | "low",
  threshold: number
): string {
  const unitSuffix = unit ? ` ${unit}` : "";
  if (clearedSide === "high") {
    return `${tagName} returned below ${clearedKind} high limit (value ${value}${unitSuffix}, threshold ${threshold}${unitSuffix})`;
  }
  return `${tagName} returned above ${clearedKind} low limit (value ${value}${unitSuffix}, threshold ${threshold}${unitSuffix})`;
}

function clearedFromPayload(
  payload: AlertPayload,
  def: { warnHigh: number | null; warnLow: number | null; alarmHigh: number | null; alarmLow: number | null }
) {
  const clearedKind = payload.kind ?? "warn";
  const clearedSide = payload.side ?? "high";
  const threshold =
    typeof payload.threshold === "number"
      ? payload.threshold
      : clearedSide === "high"
        ? (clearedKind === "alarm" ? def.alarmHigh : def.warnHigh) ?? 0
        : (clearedKind === "alarm" ? def.alarmLow : def.warnLow) ?? 0;
  return { clearedKind, clearedSide, threshold };
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

        const triggers: Trigger[] = [];

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

        if (triggers.length === 0) {
          const openAlerts = await db
            .select({ alert: schema.alertEvents })
            .from(schema.alertEvents)
            .innerJoin(
              schema.alertTags,
              eq(schema.alertTags.alertEventId, schema.alertEvents.id)
            )
            .where(
              and(
                eq(schema.alertEvents.machineId, machineId),
                eq(schema.alertTags.tagId, tagId),
                inArray(schema.alertEvents.status, ["open", "acknowledged"])
              )
            );

          if (!openAlerts.length) continue;

          const resolvedIds: string[] = [];
          for (const { alert } of openAlerts) {
            const existingPayload = (alert.payload ?? {}) as AlertPayload;
            const { clearedKind, clearedSide, threshold } = clearedFromPayload(existingPayload, def);
            const reason = buildClearReason(def.name, def.unit, v, clearedKind, clearedSide, threshold);
            const resolution = {
              source: "threshold_clear",
              actor: "system",
              at: now.toISOString(),
              tagSlug: def.slug,
              value: v,
              unit: def.unit ?? null,
              clearedKind,
              clearedSide,
              threshold,
              reason
            };

            await db
              .update(schema.alertEvents)
              .set({
                status: "resolved",
                endsAt: now,
                dedupeKey: null,
                payload: { ...existingPayload, resolution }
              })
              .where(eq(schema.alertEvents.id, alert.id));

            resolvedIds.push(alert.id);
          }

          logger.info({ alertIds: resolvedIds, machineId, tagId }, "alerts auto-resolved");
          continue;
        }

        const primary = triggers.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "alarm" ? -1 : 1))[0]!;
        const severity = computeSeverity(primary.kind);
        const dedupeKey = `${machineId}:${machineRevision}:${tagId}:${primary.kind}:${primary.side}`;
        const breachPayload = {
          tagId,
          tagSlug: def.slug,
          value: v,
          ts: latest.ts.toISOString(),
          threshold: primary.threshold,
          kind: primary.kind,
          side: primary.side
        };
        const description = breachDescription(def, v, primary);

        const existing = await db
          .select()
          .from(schema.alertEvents)
          .where(
            and(
              eq(schema.alertEvents.machineId, machineId),
              eq(schema.alertEvents.dedupeKey, dedupeKey),
              eq(schema.alertEvents.status, "open")
            )
          )
          .limit(1);

        if (existing.length > 0) {
          const row = existing[0]!;
          await db
            .update(schema.alertEvents)
            .set({
              description,
              payload: breachPayload
            })
            .where(eq(schema.alertEvents.id, row.id));
          logger.debug({ alertId: row.id, machineId, tagId }, "alert updated (deduped)");
          continue;
        }

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
              description,
              dedupeKey,
              payload: breachPayload,
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
