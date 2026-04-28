import { getPgDb, schema } from "../db/index";

async function checkAlerts() {
  const db = getPgDb();
  const alerts = await db.select().from(schema.alertEvents);
  console.log("Total Alerts in PG:", alerts.length);
  alerts.forEach((a: any) => {
    console.log(`ID: ${a.id}, Title: ${a.title}, StartsAt: ${a.startsAt}, StartsAt (ISO): ${a.startsAt?.toISOString()}`);
  });
  process.exit(0);
}

checkAlerts().catch(console.error);
