import type { BaseLogger } from "pino";
import { tryGetBoss } from "../queue/boss.js";
import { registerAlertDetectionWorker } from "./alertDetection.js";
import { registerDeliveryWorker } from "./deliveryWorker.js";
import { registerReportRunner } from "./reportRunner.js";
import { startReportScheduler } from "./reportScheduler.js";

export async function startWorkers({ logger }: { logger: any }) {
  // Workers are started in-process for desktop simplicity.
  // Heavy workloads should be moved to separate PM2 processes.
  logger.info("workers starting");

  const boss = await tryGetBoss();
  if (!boss) {
    logger.warn("pg-boss unavailable (Postgres not reachable); workers disabled");
    return;
  }

  await registerAlertDetectionWorker(boss, logger);
  await registerDeliveryWorker(boss, logger);
  await registerReportRunner(boss, logger);
  await startReportScheduler(boss, logger);
  logger.info("workers started");
}

