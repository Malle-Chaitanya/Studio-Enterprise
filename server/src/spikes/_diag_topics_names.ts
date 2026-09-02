import { getDb, connectDb, isDbConnected } from '../db/core.js';
import { config } from '../config.js';
await connectDb(config.CSGE_DB);
if (!isDbConnected()) { console.log('no db'); process.exit(1); }
const rows = await getDb(config.CSGE_DB).collection('agentIRCache')
  .find({ 'ir.name': { $in: ['Deal Desk', 'Sales desk'] } },
        { projection: { _id: 0, 'ir.name': 1, 'ir.topics': 1, 'mapped': 1 } }).toArray();
for (const r of rows as any[]) {
  console.log(`\n=== ${r.ir.name}`);
  for (const t of r.ir.topics ?? []) console.log(`  topic: ${t.name}  (${t.kind ?? '-'})`);
  const m = r.mapped;
  if (m) console.log('  mapped keys:', Object.keys(m).join(', '));
}
process.exit(0);
