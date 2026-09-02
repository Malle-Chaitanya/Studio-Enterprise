/**
 * One-off: rewrite identityMappings rows keyed by project NUMBER to the project ID.
 *
 * Sessions used to store the number; discovery now returns the id. Without this, a
 * reconnect looks up a key nothing was written under and the customer's saved user
 * mappings come back empty.
 *
 * Dry by default. Pass --apply to write.
 */
import { connectMongo } from '../db/mongo.js';
import { config } from '../config.js';
import { getDb } from '../db/core.js';
import { canonicalProjectId, getSaToken } from '../auth/google.js';

const apply = process.argv.includes('--apply');
await connectMongo();
const coll = getDb(config.CSGE_DB).collection('identityMappings');
const rows = await coll.find({ geminiProject: { $regex: '^[0-9]+$' } }).toArray();
console.log(`numeric-keyed rows: ${rows.length}${apply ? '' : '  (dry run — pass --apply to write)'}`);

const token = await getSaToken();
for (const r of rows) {
  const num = String(r.geminiProject);
  const id = await canonicalProjectId(num, token);
  if (id === num) { console.log(`  ${num} -> UNRESOLVED, left alone`); continue; }
  const clash = await coll.findOne({ appUserId: r.appUserId, tenantId: r.tenantId, geminiProject: id });
  if (clash) {
    // Both representations already have a row. Merging is a judgement call about whose
    // mapping wins, so it is reported rather than decided here.
    console.log(`  ${num} -> ${id}  BOTH EXIST — not merged, resolve by hand`);
    continue;
  }
  console.log(`  ${num} -> ${id}${apply ? '  rewritten' : ''}`);
  if (apply) await coll.updateOne({ _id: r._id }, { $set: { geminiProject: id } });
}
process.exit(0);
