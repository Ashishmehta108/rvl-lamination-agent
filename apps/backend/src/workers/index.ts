import type { Logger } from "pino";

export async function startWorkers({ logger }: { logger: Logger }) {
  // Workers are started in-process for desktop simplicity.
  // Heavy workloads should be moved to separate PM2 processes.
  logger.info("workers starting");
}

