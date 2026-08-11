import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
async function main() {
  await connectMongo();
  const docs = await getDb().collection('adkKnowledgeStores').find({
    sourceId: { $in: ['48248234-cb90-f111-8077-0022480a981d', 'ee2ea155-208c-f111-ab0f-0022480a981d'] },
  }).toArray();
  for (const d of docs) console.log(JSON.stringify(d, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
