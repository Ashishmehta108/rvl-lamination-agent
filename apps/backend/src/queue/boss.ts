import PgBoss from "pg-boss";
import { config } from "../config.js";

let bossSingleton: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossSingleton) return bossSingleton;
  const boss = new PgBoss({
    connectionString: config.postgresUrl,
    schema: config.queueSchema,
    // production-safe defaults; can be tuned per machine
    retryLimit: 8,
    retryDelay: 10,
    expireInSeconds: 60 * 15
  });
  await boss.start();
  bossSingleton = boss;
  return bossSingleton;
}

export async function tryGetBoss(): Promise<PgBoss | null> {
  try {
    return await getBoss();
  } catch {
    return null;
  }
}

