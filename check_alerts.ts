import "dotenv/config";
import { getPgDb, schema } from "./packages/db-postgres/src/index.js";
import { and, eq, gte, lte } from "drizzle-orm";

async function checkAlerts() {
  try {
    const db = getPgDb();
    
    const rangeStart = new Date(2026, 3, 27); 
    const rangeEnd = new Date(2026, 3, 28);
    
    console.log(`Querying: from=${rangeStart.toISOString()} to=${rangeEnd.toISOString()}`);
    
    const rows = await db
      .select()
      .from(schema.alertEvents)
      .where(
        and(
          eq(schema.alertEvents.machineId, "lamination-01"),
          gte(schema.alertEvents.startsAt, rangeStart),
          lte(schema.alertEvents.startsAt, rangeEnd)
        )
      );
    
    console.log("Rows found with range query:", rows.length);
    rows.forEach(a => console.log(`  Match: ${a.title} at ${a.startsAt}`));

    const all = await db.select().from(schema.alertEvents);
    console.log("Total Alerts in DB:", all.length);
    all.forEach(a => console.log(`  All: ${a.title} at ${a.startsAt} (machine: ${a.machineId})`));

  } catch (err) {
    console.error("Failed:", err);
  } finally {
    process.exit(0);
  }
}

checkAlerts();
