/**
 * Which agents are ALREADY migrated, per our own deployment records?
 *
 * Re-migration keys on this record (orchestrator.ts: getAdkDeployment), not on the agent's
 * name, so this is the list that decides whether a run reuses an agent or creates one.
 *
 * Read-only.  npx tsx src/spikes/_diag_migrated_so_far.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const rows = await getDb().collection('adkDeployments').find({}).sort({ $natural: -1 }).limit(50).toArray();
console.log(`${rows.length} deployment record(s)\n`);
for (const r of rows as any[]) {
  console.log(`  ${(r.displayName ?? r.sourceId ?? '?').toString().slice(0, 42).padEnd(42)} agentId=${r.agentId ?? '?'}`);
  console.log(`      sourceId=${r.sourceId}  env=${(r.envUrl ?? '').replace('https://', '')}  project=${r.project ?? r.dest?.project ?? '?'}`);
  console.log(`      engine=${(r.reasoningEngine ?? '').split('/').pop() ?? '-'}  updated=${r.updatedAt ?? r.createdAt ?? '?'}`);
}
process.exit(0);
