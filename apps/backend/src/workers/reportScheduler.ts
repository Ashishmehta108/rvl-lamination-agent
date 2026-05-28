
import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import cron from "node-cron";
import * as cronParser from "cron-parser";
import { getPgDb, schema } from "@rvl/db-postgres";
import { eq, sql } from "drizzle-orm";
import { Jobs } from "./jobs.js";
import { config } from "../config.js";

// Minimal scheduler: polls schedules every minute and enqueues when cron matches.
// For industrial usage, store nextRunAt and compute deterministically per timezone.

export async function startReportScheduler(boss: PgBoss, logger: Logger) {
  await ensureDefaultDailySchedule(logger);

  cron.schedule("* * * * *", async () => {
    const db = getPgDb();
    const schedules = await db.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.enabled, true));

    for (const s of schedules) {
      const now = new Date();
      if (!cron.validate(s.cron)) continue;

      let scheduledAt: Date | null = null;
      try {
        const interval = cronParser.CronExpressionParser.parse(s.cron, {
          currentDate: new Date(now.getTime() + 1000),
          tz: s.timezone ?? "UTC"
        } as any);
        scheduledAt = interval.prev().toDate();
      } catch (err) {
        logger.warn({ scheduleId: s.id, cron: s.cron, err: String(err) }, "invalid_cron_expression");
        continue;
      }

      // Only consider matches for the current tick (last 60s)
      if (!scheduledAt || scheduledAt.getTime() < now.getTime() - 60 * 1000) continue;
      if (s.lastRunAt && s.lastRunAt.getTime() >= scheduledAt.getTime()) continue;

      // Cross-instance safety: only one scheduler should enqueue per schedule per minute bucket
      const bucket = Math.floor(scheduledAt.getTime() / (60 * 1000));
      const lockKey2 = hash32(`${s.id}:${bucket}`);
      const lockRes = await db.execute(
        sql`select pg_try_advisory_lock(${9011}::int, ${lockKey2}::int) as ok`
      );
      const locked = Boolean((lockRes as any)?.rows?.[0]?.ok);
      if (!locked) continue;

      try {
        const windowEnd = scheduledAt;
        const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
        await boss.send(Jobs.reportRun, {
          scheduleId: s.id,
          templateId: s.templateId,
          machineId: s.machineId,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString()
        });

        await db.update(schema.reportSchedules).set({ lastRunAt: windowEnd }).where(eq(schema.reportSchedules.id, s.id));
      } finally {
        await db.execute(sql`select pg_advisory_unlock(${9011}::int, ${lockKey2}::int)`);
      }
    }
  });

  logger.info("report scheduler started");
}

async function ensureDefaultDailySchedule(logger: Logger) {
  const db = getPgDb();
  const templateId = "template_rvl_daily_performance";
  const scheduleId = "sched_rvl_daily";

  await db.insert(schema.reportTemplates).values({
    id: templateId,
    name: "Daily Performance Report",
    description: "Automatic daily machine performance report",
    format: "html",
    definition: { kind: "daily_performance" }
  }).onConflictDoNothing();

  await db.insert(schema.reportSchedules).values({
    id: scheduleId,
    templateId,
    machineId: config.machineId,
    timezone: "Asia/Kolkata",
    cron: "0 8 * * *",
    enabled: true,
    deliveryTargets: {}
  }).onConflictDoNothing();

  logger.info({ scheduleId, machineId: config.machineId, cron: "0 8 * * *", timezone: "Asia/Kolkata" }, "default daily report schedule ensured");
}

function hash32(input: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Convert to signed int32 range expected by pg_try_advisory_lock(int,int)
  return h | 0;
}

