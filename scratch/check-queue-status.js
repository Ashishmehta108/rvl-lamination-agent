import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  try {
    console.log('Checking pg-boss jobs...');
    
    // Check job counts by status
    const counts = await pool.query(`
      SELECT name, state, count(*) 
      FROM pgboss.job 
      GROUP BY name, state
      ORDER BY name, state;
    `);
    console.table(counts.rows);

    // Check recent failed jobs
    const failedJobs = await pool.query(`
      SELECT id, name, state, response, created_on, started_on, completed_on
      FROM pgboss.job
      WHERE state = 'failed'
      ORDER BY completed_on DESC
      LIMIT 5;
    `);
    console.log('\nRecent failed jobs:');
    failedJobs.rows.forEach(j => {
        console.log(`- ID: ${j.id}, Name: ${j.name}, Error: ${JSON.stringify(j.response)}`);
    });

    // Check report_runs table
    const reportRuns = await pool.query(`
        SELECT id, status, metrics, error, created_at
        FROM report_runs
        ORDER BY created_at DESC
        LIMIT 5;
    `);
    console.log('\nReport Runs table:');
    console.table(reportRuns.rows);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
