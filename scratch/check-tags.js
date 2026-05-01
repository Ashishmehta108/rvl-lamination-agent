import { MongoClient } from 'mongodb';

const url = 'mongodb://localhost:27017';
const client = new MongoClient(url);

async function main() {
  try {
    await client.connect();
    const db = client.db('rvl');
    const tagIds = [
      'tag_01KPZ65TV4FEYKAX7W8H0GZ149',
      'tag_01KPZ65TV5TYNE214NMCYH2C9V',
      'tag_01KPZ65TV6Q9K4599Z5WXZ4VM4',
      'tag_01KPZ65TV8AE5B6W488VJ5X4Z0'
    ];
    const tags = await db.collection('Tag').find({ _id: { $in: tagIds } }).toArray();
    console.log(JSON.stringify(tags.map(t => ({ id: t._id, slug: t.slug, name: t.name })), null, 2));
  } finally {
    await client.close();
  }
}

main().catch(console.error);
