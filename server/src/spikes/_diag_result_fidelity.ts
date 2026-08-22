/** The fidelity notes on an agent's newest result row — the customer-facing record of what
 *  happened, and DB-backed, so it survives a truncated log file. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const r = (await getDb().collection('migrationResults').findOne({ sourceId: process.argv[2] }, { sort: { _id: -1 } })) as Record<string, any> | null;
if (!r) { console.log('no result'); process.exit(0); }
console.log(`${r.name}: deployed=${r.deployed} shared=${r.shared} verified=${r.verified} verifyStatus=${r.verifyStatus ?? '-'} agentId=${r.geminiAgentId}`);
for (const f of (r.fidelity ?? []) as Array<Record<string, any>>) {
  if (!['lost', 'needs-review', 'partial'].includes(String(f.status))) continue;
  console.log(`\n  [${f.status}] ${f.component}`);
  console.log(`     ${String(f.detail).slice(0, 400)}`);
}
process.exit(0);
