import { getDb, connectDb, isDbConnected } from '../db/core.js';
import { config } from '../config.js';
await connectDb(config.CSGE_DB);
const rows = await getDb(config.CSGE_DB).collection('agentIRCache')
  .find({ 'ir.name': { $in: ['Deal Desk', 'Sales desk'] } },
        { projection: { _id: 0, 'ir.name': 1, 'mapped.tools': 1 } }).toArray();
for (const r of rows as any[]) {
  console.log(`\n=== ${r.ir.name}`);
  console.log(JSON.stringify(r.mapped?.tools, null, 2).slice(0, 3000));
}
process.exit(0);
