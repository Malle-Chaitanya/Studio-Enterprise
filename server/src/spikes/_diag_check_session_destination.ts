/** Why did the deployment land in project 231705905417 when the run's own log said
 *  "Destination engine: ...(project 72860638029)"? Check the session's stored
 *  plan.destination.environmentMap for a stale per-environment override.
 *  npx tsx src/spikes/_diag_check_session_destination.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const s = await getDb().collection('migrationSessions').findOne({ _id: 'EzMXKu56qW-XIR1GkP4VEAwmUTY' as unknown as never });
  if (!s) { console.log('NOT FOUND'); process.exit(1); }
  console.log(JSON.stringify({
    geminiProject: s.geminiProject,
    planDestination: s.plan?.destination,
  }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
