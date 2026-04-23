/**
 * ML worker: handles ml.retrain jobs from pg-boss.
 * Calls the Python ML server's /retrain endpoint.
 */

import type PgBoss from "pg-boss";
import type { BaseLogger } from "pino";
import { Jobs } from "./jobs.js";
import { mlTriggerRetrain, mlGetStatus } from "../services/mlService.js";

export async function registerMlWorker(boss: PgBoss, logger: BaseLogger) {
  await boss.work<{ force?: boolean }>(
    Jobs.mlRetrain,
    { teamConcurrency: 1 } as any,
    async (job: any) => {
      const force = Boolean(job?.data?.force ?? false);
      logger.info({ force }, "ml.retrain job started");

      const ok = await mlTriggerRetrain(force);
      if (ok) {
        logger.info("ml.retrain triggered successfully on ML server");
        // Allow a moment for the background train to start, then log status
        await new Promise((r) => setTimeout(r, 2000));
        const status = await mlGetStatus();
        if (status?.model?.trained_at) {
          logger.info({ trainedAt: status.model.trained_at }, "ml model status after retrain request");
        }
      } else {
        logger.warn(
          "ml.retrain could not reach ML server — is packages/ml/server.py running?"
        );
      }
    }
  );

  logger.info("ml worker registered");
}
