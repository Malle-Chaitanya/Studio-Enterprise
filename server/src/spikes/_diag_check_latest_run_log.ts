/** What does the most recent migration run's persisted log actually say about the ADK
 *  deploy attempt for Deal Desk — did it fail again, and why? Read-only.
 *  npx tsx src/spikes/_diag_check_latest_run_log.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();

const latestRun = await db.collection('migrationRuns').find({}).sort({ $natural: -1 }).limit(1).next();
console.log('Latest run:', JSON.stringify(latestRun, null, 2)?.slice(0, 1000));

const logs = await db
  .collection('migrationLogs')
  .find(latestRun ? { runId: latestRun._id } : {})
  .sort({ $natural: -1 })
  .limit(400)
  .toArray();
console.log(`\n${logs.length} log rows found for this run. Showing ones mentioning ADK/deploy/error/fail:`);
for (const l of logs.reverse()) {
  const msg = String(l.msg ?? l.message ?? JSON.stringify(l));
  if (/adk|deploy|fail|error|sub-agent|tool/i.test(msg)) {
    console.log(`  [${l.level ?? '-'}] ${msg.slice(0, 500)}`);
  }
}
process.exit(0);
