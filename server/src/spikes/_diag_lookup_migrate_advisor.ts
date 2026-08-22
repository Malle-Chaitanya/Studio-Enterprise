import 'dotenv/config';
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const dep = await db.collection('adkDeployments').findOne({
    $or: [{ agentId: '16275653330643195977' }, { reasoningEngine: { $regex: '6940215800812797952' } }],
  });
  console.log('adkDeployments record:', JSON.stringify(dep, null, 2));

  if (dep) {
    const ir = await db.collection('agentIRCache').findOne({ appUserId: dep.appUserId, envUrl: dep.envUrl, sourceId: dep.sourceId });
    console.log('agentIRCache found:', !!ir, ir ? Object.keys(ir) : null);
  }

  const staged = await db.collection('stagedAgents').find({ 'ir.name': 'Migrate Advisor' }).toArray();
  console.log('stagedAgents matches:', staged.length);
  for (const s of staged) {
    console.log('-', { appUserId: s.appUserId, envUrl: s.envUrl, sourceId: s.sourceId ?? s.ir?.sourceId, stagedAt: s.stagedAt });
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
