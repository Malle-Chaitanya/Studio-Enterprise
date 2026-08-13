/** Set plan.forceRedeploy=true directly on the session so the drift-detection
 *  logic doesn't skip redeploying "A" just because the source agent itself hasn't
 *  changed — we need to redeploy for OUR OWN code fix (google_drive.py), which
 *  drift detection has no way to know about.
 *  npx tsx src/spikes/_diag_set_force_redeploy.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const SESSION_ID = 'rrEUmOOQr6_fu9apFOVPuBy0jbE';

async function main() {
  await connectMongo();
  const res = await getDb().collection('migrationSessions').updateOne(
    { _id: SESSION_ID as unknown as never },
    { $set: { 'plan.forceRedeploy': true } },
  );
  console.log('matched:', res.matchedCount, 'modified:', res.modifiedCount);
  const s = await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as unknown as never });
  console.log('plan.forceRedeploy now:', s?.plan?.forceRedeploy);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
