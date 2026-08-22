/** All deployment rows for one agent, newest first — a forced redeploy should have written a
 *  new reasoningEngine, and if it did not, the record and the live agent disagree. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = (await getDb().collection('adkDeployments').find({ sourceId: process.argv[2] }).sort({ _id: -1 }).toArray()) as Array<Record<string, any>>;
console.log(`${rows.length} row(s)`);
for (const r of rows) {
  console.log(`  deployedAt=${String(r.deployedAt)} agentId=${r.agentId} re=${String(r.reasoningEngine).split('/').pop()}`);
}
process.exit(0);
