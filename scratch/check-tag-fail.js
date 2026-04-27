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
    console.log('Fetching one failed tag.updated job...');
    const oneJob = await pool.query(`SELECT * FROM pgboss.job WHERE name = 'tag.updated' AND state = 'failed' LIMIT 1;`);
    if (oneJob.rows[0]) {
        console.log('Job Output:', oneJob.rows[0].output);
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
