import { MongoClient } from 'mongodb';

const url = 'mongodb://localhost:27017';
const client = new MongoClient(url);

async function main() {
  try {
    await client.connect();
    const db = client.db('rvl');
    const tagIds = [
      'tag_01KPZ65V350KQ4JKFJKASHJK00',
      'tag_01KPZ65V3460PWR1G4TVSYYJRE',
      'tag_01KPZ65V3614DTN9S3FMJR1RSR',
      'tag_01KPZ65V35GPMQPWA0WT6QZT1M',
      'tag_01KPZ65V337EF15CB15GP3FZYG'
    ];
    const tags = await db.collection('Tag').find({ _id: { $in: tagIds } }).toArray();
    console.log(JSON.stringify(tags.map(t => ({ id: t._id, slug: t.slug, name: t.name })), null, 2));
  } finally {
    await client.close();
  }
}

main().catch(console.error);
