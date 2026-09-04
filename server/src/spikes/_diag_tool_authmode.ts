import { getDb, connectDb, isDbConnected } from '../db/core.js';
import { config } from '../config.js';

await connectDb(config.CSGE_DB);
if (!isDbConnected()) { console.log('no db'); process.exit(1); }
const rows = await getDb(config.CSGE_DB).collection('agentIRCache')
  .find({}, { projection: { _id: 0, 'ir.name': 1, 'ir.agentTools': 1 } }).toArray();
for (const r of rows as any[]) {
  const ir = r.ir; if (!ir) continue;
  const tools = ir.agentTools ?? [];
  if (!tools.length) continue;
  console.log(`\n=== ${ir.name} (${tools.length} tools)`);
  for (const t of tools) {
    console.log(`  ${t.name ?? t.displayName ?? '?'}  mode=${t.connectionAuthMode ?? '-'}  connector=${t.connectorId ?? '-'}  kind=${t.kind ?? '-'}`);
  }
}
process.exit(0);
