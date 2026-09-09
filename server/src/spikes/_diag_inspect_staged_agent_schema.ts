/** Inspect the real shape of a deployed StagedAgent doc's mapped.ir, to find the
 *  correct field for connector/tool kind info (my first blast-radius audit guessed
 *  wrong field names and got 0 matches for a known-affected agent).
 *  npx tsx src/spikes/_diag_inspect_staged_agent_schema.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

await connectMongo();
const db = getDb(config.CSGE_DB);

const doc = await db.collection('stagedAgents').findOne({ name: /deal desk/i });
if (!doc) {
  console.log('No staged agent named "Deal Desk" found. Trying any deployed doc instead.');
  const any = await db.collection('stagedAgents').findOne({ deployed: true });
  console.log(any ? Object.keys(any) : 'NONE FOUND');
  process.exit(0);
}

console.log('Top-level keys:', Object.keys(doc));
console.log('deployed:', (doc as any).deployed, 'insertedAt:', (doc as any).insertedAt);
const ir = (doc as any).mapped?.ir;
console.log('\nmapped.ir keys:', ir ? Object.keys(ir) : 'NO mapped.ir');
for (const key of Object.keys(ir ?? {})) {
  const val = ir[key];
  if (Array.isArray(val) && val.length) {
    console.log(`\nir.${key} (array, length ${val.length}), first item:`);
    console.log(JSON.stringify(val[0], null, 2).slice(0, 800));
  }
}
process.exit(0);
