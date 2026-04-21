import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import cron from "node-cron";
import { getPgDb, schema } from "@rvl/db-postgres";
import { eq } from "drizzle-orm";
import { Jobs } from "./jobs.js";

// Minimal scheduler: polls schedules every minute and enqueues when cron matches.
// For industrial usage, store nextRunAt and compute deterministically per timezone.

export async function startReportScheduler(boss: PgBoss, logger: Logger) {
  cron.schedule("* * * * *", async () => {
    const db = getPgDb();
    const schedules = await db.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.enabled, true));

    for (const s of schedules) {
      // node-cron can check if cron matches "now"
      const now = new Date();
      if (!cron.validate(s.cron)) continue;

      // Lightweight guard: only run once per hour per schedule unless lastRunAt is older.
      if (s.lastRunAt && now.getTime() - s.lastRunAt.getTime() < 60 * 60 * 1000) continue;

      const windowEnd = now;
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      await boss.send(Jobs.reportRun, {
        scheduleId: s.id,
        templateId: s.templateId,
        machineId: s.machineId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString()
      });

      await db.update(schema.reportSchedules).set({ lastRunAt: now }).where(eq(schema.reportSchedules.id, s.id));
    }
  });

  logger.info("report scheduler started");
}

