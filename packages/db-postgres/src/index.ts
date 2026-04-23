import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export * as schema from "./schema.js";

let poolSingleton: Pool | null = null;

export function getPgPool(): Pool {
  if (!poolSingleton) {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("POSTGRES_URL is required");
    poolSingleton = new Pool({ connectionString: url, max: 10 });
  }
  return poolSingleton;
}

export function getPgDb() {
  return drizzle(getPgPool());
}

