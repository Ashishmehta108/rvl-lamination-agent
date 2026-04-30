import { getPgDb, getPgPool, schema } from "@rvl/db-postgres";

export { schema };

export function getPostgresDb() {
  return getPgDb();
}

export async function closePostgres(): Promise<void> {
  await getPgPool().end();
}
