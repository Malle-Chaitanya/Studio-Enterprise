import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const all = await getDb().collection('migrationResults')
    .find({ name: /migrate advisor/i })
    .sort({ $natural: -1 })
    .project({ name: 1, geminiAgentId: 1, verified: 1, verifyStatus: 1, updatedAt: 1 })
    .toArray();
  console.log('All Migrate Advisor results (newest first):');
  console.log(JSON.stringify(all, null, 2));

  const verifiedOthers = await getDb().collection('migrationResults')
    .find({ verifyStatus: 'verified' })
    .sort({ $natural: -1 })
    .limit(5)
    .project({ name: 1, geminiAgentId: 1, verifyStatus: 1, updatedAt: 1 })
    .toArray();
  console.log('\nOther agents with verifyStatus=verified (candidates for a safer demo):');
  console.log(JSON.stringify(verifiedOthers, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
