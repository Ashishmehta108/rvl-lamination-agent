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
    console.log('Fetching one failed job to see columns...');
    const oneJob = await pool.query(`SELECT * FROM pgboss.job WHERE state = 'failed' LIMIT 1;`);
    console.log('Columns:', Object.keys(oneJob.rows[0] || {}));
    if (oneJob.rows[0]) {
        console.log('Job Data:', oneJob.rows[0]);
    }

    console.log('\nReport Runs:');
    const reports = await pool.query(`SELECT id, status, error, metrics FROM report_runs ORDER BY created_at DESC LIMIT 5;`);
    console.table(reports.rows);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
