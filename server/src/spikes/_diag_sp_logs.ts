/**
 * Did a real migration run ever index SharePoint content?
 *
 * migrationLogs is the run's own transcript, so it answers what the pipeline DID, as
 * opposed to what a mechanism spike proved it CAN do. Indexed on appUserId + ts, so query
 * with a bounded sort rather than a collection scan.
 *
 * Read-only.  npx tsx src/spikes/_diag_sp_logs.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const col = getDb().collection('migrationLogs');
console.log(`${await col.estimatedDocumentCount()} log line(s) total`);
const rows = await col.find({}, { projection: { ts: 1, level: 1, msg: 1, text: 1 } })
  .sort({ $natural: -1 }).limit(20000).toArray();
const RE = /sharepoint|copy.mode|graph download|agentFiles/i;
const hits = (rows as any[]).filter((r) => RE.test(`${r.msg ?? ''}${r.text ?? ''}`));
console.log(`${hits.length} SharePoint/copy-mode line(s) in the last ${rows.length}\n`);
for (const h of hits.slice(0, 40)) {
  console.log(`${String(h.ts ?? '').slice(0, 19)} [${h.level}] ${String(h.msg ?? h.text).slice(0, 220)}`);
}
process.exit(0);
