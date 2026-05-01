import type { BaseLogger } from "pino";
import { tryGetBoss } from "../queue/boss.js";
import { registerAlertDetectionWorker } from "./alertDetection.js";
import { registerDeliveryWorker } from "./deliveryWorker.js";
import { registerReportRunner } from "./reportRunner.js";
import { registerReportEmailWorker } from "./reportEmailWorker.js";
import { startReportScheduler } from "./reportScheduler.js";
import { registerMlWorker } from "./mlWorker.js";
import { config } from "../config.js";
import { Jobs } from "./jobs.js";
import cron from "node-cron";

let started = false;
let retrying = false;

export async function startWorkers({ logger }: { logger: any }) {
  // Workers are started in-process for desktop simplicity.
  // Heavy workloads should be moved to separate PM2 processes.
  if (started) return;
  logger.info("workers starting");

  const boss = await tryGetBoss();
  if (!boss) {
    logger.warn("pg-boss unavailable (Postgres not reachable); workers disabled");
    if (config.nodeEnv === "production") {
      throw new Error("Workers required in production, but pg-boss is unavailable");
    }
    if (!retrying) {
      retrying = true;
      const retry = async () => {
        const b = await tryGetBoss();
        if (!b) return;
        retrying = false;
        await startWorkers({ logger });
      };
      setInterval(() => void retry(), 3000);
      logger.info("will retry workers startup every 3s");
    }
    return;
  }

  await registerAlertDetectionWorker(boss, logger);
  await registerDeliveryWorker(boss, logger);
  await registerReportRunner(boss, logger);
  await registerReportEmailWorker(boss, logger);
  await registerMlWorker(boss, logger);
  await startReportScheduler(boss, logger);

  // Weekly ML retrain: every Sunday at 02:00 AM UTC
  const mlRetrainCron = process.env["ML_RETRAIN_CRON"] ?? "0 2 * * 0";
  if (cron.validate(mlRetrainCron)) {
    cron.schedule(mlRetrainCron, async () => {
      try {
        await boss.send(Jobs.mlRetrain, {});
        logger.info("ml.retrain job enqueued by weekly scheduler");
      } catch (err) {
        logger.error({ err: String(err) }, "failed to enqueue ml.retrain");
      }
    });
    logger.info({ cron: mlRetrainCron }, "ML weekly retrain scheduled");
  } else {
    logger.warn({ cron: mlRetrainCron }, "Invalid ML_RETRAIN_CRON, weekly retrain disabled");
  }

  started = true;
  logger.info("workers started");
}

