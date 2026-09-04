import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const all = await getDb().collection('migrationResults')
    .find({ name: /workmate/i })
    .sort({ $natural: -1 })
    .project({ name: 1, geminiAgentId: 1, verified: 1, verifyStatus: 1, updatedAt: 1, sourceId: 1, appUserId: 1 })
    .toArray();
  console.log('All WorkMate results (newest first):');
  console.log(JSON.stringify(all, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
