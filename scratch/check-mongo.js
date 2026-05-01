import { MongoClient } from 'mongodb';

const url = 'mongodb://localhost:27017';
const client = new MongoClient(url);

async function main() {
  try {
    await client.connect();
    const db = client.db('rvl');
    const tags = await db.collection('Tag').find().toArray();
    console.log('Tags:', JSON.stringify(tags.map(t => ({ id: t._id, slug: t.slug, name: t.name })), null, 2));
    
    const tagLatest = await db.collection('TagLatest').find().toArray();
    console.log('Latest Data:', JSON.stringify(tagLatest.map(t => ({ machineId: t.machineId, tagId: t.tagId, value: t.valueNumber })), null, 2));
    
  } finally {
    await client.close();
  }
}

main().catch(console.error);
