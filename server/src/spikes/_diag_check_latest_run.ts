/** curl's SSE connection timed out client-side after 5 minutes — check whether the
 *  server-side migration run actually kept going (or finished) regardless, since the
 *  orchestrator may not tie real work to the HTTP connection staying open.
 *  npx tsx src/spikes/_diag_check_latest_run.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const runs = await getDb()
    .collection('migrationRuns')
    .find({})
    .sort({ $natural: -1 })
    .limit(3)
    .toArray();
  console.log('--- migrationRuns (latest 3) ---');
  for (const r of runs) {
    console.log(JSON.stringify({ runId: r.runId, appUserId: r.appUserId, startTime: r.startTime, status: r.status, summary: r.summary }, null, 2));
  }

  const results = await getDb()
    .collection('migrationResults')
    .find({})
    .sort({ $natural: -1 })
    .limit(3)
    .toArray();
  console.log('\n--- migrationResults (latest 3) ---');
  for (const r of results) {
    console.log(JSON.stringify({
      runId: r.runId, name: r.name, ok: r.ok, error: r.error, agentId: r.agentId,
      fidelityCount: r.fidelity?.length, statuses: r.fidelity?.map((f: { status: string }) => f.status),
    }, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
