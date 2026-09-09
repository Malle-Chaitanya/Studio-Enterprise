/** The FULL, untruncated ADK deploy error from the latest run — no .slice() this time.
 *  npx tsx src/spikes/_diag_full_adk_error.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const latestRun = await db.collection('migrationRuns').find({}).sort({ $natural: -1 }).limit(1).next();
const logs = await db
  .collection('migrationLogs')
  .find({ runId: latestRun?._id })
  .sort({ $natural: 1 })
  .toArray();
console.log(`Run ${latestRun?._id} — ${logs.length} total log lines.\n`);
for (const l of logs) {
  console.log(`[${l.level}] ${l.msg}`);
}
process.exit(0);
