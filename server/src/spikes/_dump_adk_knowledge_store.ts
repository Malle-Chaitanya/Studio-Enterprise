import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

async function main() {
  await connectMongo();
  const docs = await getDb(config.CSGE_DB).collection('adkKnowledgeStores').find({
    fileName: /Slack/i,
  }).toArray();
  console.log(`found ${docs.length} adkKnowledgeStores doc(s):`);
  console.log(JSON.stringify(docs, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
