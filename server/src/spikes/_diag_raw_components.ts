/** Component inventory from the raw landing record — what Dataverse actually returned. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const col = getDb().collection('rawAgents');
const rows = await col.find({ sourceId: process.argv[2] }).sort({ _id: -1 }).limit(3).toArray() as any[];
console.log('raw rows found:', rows.length);
for (const r of rows) {
  const comps = r.components ?? [];
  const byType: Record<string, number> = {};
  for (const c of comps) {
    const t = String(c.componenttype ?? c.type ?? '?');
    byType[t] = (byType[t] ?? 0) + 1;
  }
  console.log(`\n${r.capturedAt ?? r._id.getTimestamp?.().toISOString()}  components=${comps.length}  disabled=${(r.disabledComponentNames ?? []).length}`);
  console.log('  byType:', JSON.stringify(byType));
  console.log('  disabled:', JSON.stringify(r.disabledComponentNames ?? []));
  for (const c of comps) {
    const t = String(c.componenttype ?? '?');
    if (t === '11' || t === '10' || /search|knowledge/i.test(String(c.name ?? ''))) {
      console.log(`   type=${t} name=${c.name} state=${c.componentstate} statecode=${c.statecode}`);
    }
  }
}
process.exit(0);
