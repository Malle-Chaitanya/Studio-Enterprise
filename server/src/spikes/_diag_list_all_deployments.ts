import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const docs = await getDb().collection('adkDeployments').find({}).toArray();
  console.log(JSON.stringify(docs.map(d => ({ sourceId: d.sourceId, agentId: d.agentId, reasoningEngine: d.reasoningEngine, deployedAt: d.deployedAt })), null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
