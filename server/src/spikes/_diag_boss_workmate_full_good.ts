import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { ObjectId } from 'mongodb';

async function main() {
  await connectMongo();
  const doc = await getDb().collection('migrationResults').findOne({ _id: new ObjectId('6a8ac39b138c6a64293fa72a') as any });
  console.log(JSON.stringify(doc, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
