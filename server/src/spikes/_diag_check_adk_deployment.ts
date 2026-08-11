import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const docs = await getDb().collection('adkDeployments').find({}).sort({ $natural: -1 }).limit(5).toArray();
  console.log(JSON.stringify(docs, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
