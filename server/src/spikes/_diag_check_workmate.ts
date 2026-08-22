import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const result = await getDb().collection('migrationResults')
    .find({ $or: [{ geminiAgentId: '8561021016517220454' }, { name: /workmate/i }] })
    .sort({ $natural: -1 })
    .limit(1)
    .next();
  console.log(JSON.stringify(result, null, 2));

  // Also check the staged agent's extracted permissions/chatAccess directly.
  const staged = await getDb().collection('stagedAgents')
    .find({ name: /workmate/i })
    .sort({ $natural: -1 })
    .limit(1)
    .next();
  console.log('\n--- staged agent permissions ---');
  console.log(JSON.stringify((staged as any)?.mapped?.ir?.permissions, null, 2));

  // And any recorded ADK deployment history for this agent.
  const adk = await getDb().collection('adkDeployments').find({ geminiAgentId: '8561021016517220454' }).toArray();
  console.log('\n--- adkDeployments records ---');
  console.log(JSON.stringify(adk, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
