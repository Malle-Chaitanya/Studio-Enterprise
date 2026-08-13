/** Confirm the session found earlier still has a stored plan + which appUserId owns it,
 *  before driving a real migration run against it via the HTTP API.
 *  npx tsx src/spikes/_diag_check_session_plan.ts <sessionId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const id = process.argv[2];
  const s = id
    ? await getDb().collection('migrationSessions').findOne({ _id: id as unknown as never })
    : await getDb()
        .collection('migrationSessions')
        .find({ plan: { $exists: true } })
        .sort({ $natural: -1 })
        .limit(1)
        .next();
  if (!s) { console.log('NOT FOUND'); process.exit(1); }
  console.log(JSON.stringify({
    sessionId: s._id,
    appUserId: s.appUserId,
    gEmail: s.gEmail,
    geminiProject: s.geminiProject,
    hasPlan: !!s.plan,
    planTotalAgents: s.plan?.totalAgents,
    acknowledgeAclLoss: s.plan?.acknowledgeAclLoss,
    dryRun: s.plan?.dryRun,
    unitEnvs: s.plan?.units?.map((u: { envName: string; bots: { name: string }[] }) => ({ env: u.envName, bots: u.bots?.map((b) => b.name) })),
  }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
