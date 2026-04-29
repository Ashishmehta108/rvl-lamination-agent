import { getPgDb, schema } from "@rvl/db-postgres";
import { and, eq, gte, lt } from "drizzle-orm";

async function check() {
  const db = getPgDb();
  const start = new Date("2026-04-27T00:00:00Z");
  const end = new Date("2026-04-28T00:00:00Z");
  
  const alerts = await db
    .select()
    .from(schema.alertEvents)
    .where(and(gte(schema.alertEvents.startsAt, start), lt(schema.alertEvents.startsAt, end)));
    
  console.log(`Found ${alerts.length} alerts on 27 April:`);
  alerts.forEach(a => console.log(`- ${a.title} [${a.severity}] at ${a.startsAt}`));
}

check().catch(console.error);
