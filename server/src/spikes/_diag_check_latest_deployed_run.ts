import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  for (const geminiAgentId of ['13300623640757970256', '2261370940660059563']) {
    const result = await getDb().collection('migrationResults')
      .find({ geminiAgentId })
      .sort({ $natural: -1 })
      .limit(1)
      .next();
    console.log(`\n=== ${(result as any)?.name} (${geminiAgentId}) ===`);
    console.log('permissionHandoff:', JSON.stringify((result as any)?.permissionHandoff, null, 2));
  }

  console.log('\n=== Current identityMappings doc (source of the "3 user override(s)") ===');
  const doc = await getDb().collection('identityMappings')
    .findOne({ tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e', appUserId: '6a5dfdff7cf05623332758b7' });
  console.log(JSON.stringify(doc, null, 2));

  console.log('\n=== Which MongoDB is this script actually connected to? ===');
  console.log('MONGO_HOST env:', process.env.MONGO_HOST);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
