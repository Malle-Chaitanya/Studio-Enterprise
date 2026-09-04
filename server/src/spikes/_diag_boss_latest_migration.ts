import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const results = await getDb().collection('migrationResults')
    .find({})
    .sort({ $natural: -1 })
    .limit(5)
    .project({ name: 1, geminiAgentId: 1, verified: 1, verifyStatus: 1, updatedAt: 1, connectorsWired: 1, capabilities: 1 })
    .toArray();
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
