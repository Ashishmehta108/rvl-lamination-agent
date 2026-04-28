const pg = require('pg');
const { Pool } = pg;

async function checkAlerts() {
  const pool = new Pool({ connectionString: 'postgresql://postgres:Ashishm108@127.0.0.1:5432/rvl?schema=public' });
  const res = await pool.query('SELECT * FROM "alert_events"');
  console.log("Total Alerts in PG:", res.rows.length);
  res.rows.forEach((a) => {
    console.log(`ID: ${a.id}, Title: ${a.title}, StartsAt: ${a.starts_at}, StartsAt (ISO): ${a.starts_at instanceof Date ? a.starts_at.toISOString() : a.starts_at}`);
  });
  await pool.end();
}

checkAlerts().catch(console.error);
