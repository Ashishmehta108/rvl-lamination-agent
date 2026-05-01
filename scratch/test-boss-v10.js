import PgBoss from 'pg-boss';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  console.log('Connecting to', process.env.POSTGRES_URL);
  const boss = new PgBoss(process.env.POSTGRES_URL);
  await boss.start();
  console.log('Boss started');
  
  const queue = 'test-queue-' + Date.now();
  console.log('Sending job to', queue);
  await boss.send(queue, { hello: 'world' });
  
  console.log('Registering worker');
  await boss.work(queue, async (args) => {
    console.log('--- WORKER EXECUTED ---');
    console.log('Is array:', Array.isArray(args));
    console.log('Args:', JSON.stringify(args, null, 2));
    if (Array.isArray(args)) {
        console.log('First item data:', args[0].data);
    } else {
        console.log('Data property:', args.data);
    }
  });

  console.log('Waiting for worker...');
  await new Promise(r => setTimeout(r, 5000));
  await boss.stop();
  console.log('Done');
  process.exit(0);
}

main().catch(console.error);
