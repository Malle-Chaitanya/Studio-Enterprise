/** What does the report actually say for Sales desk, from the real cached IR? */
import { getCachedIR } from '../db/repos/agentIR.js';
import { connectMongo } from '../db/mongo.js';
import { mapAgent } from '../services/mapper.js';

await connectMongo();
const ir = (await getCachedIR('6a7168dfc40369e8807f5cc3',
  'https://org32322095.crm.dynamics.com', 'a521051e-5ca0-f111-aaad-0022480b19e9'))?.ir;
if (!ir) { console.log('no cached IR'); process.exit(1); }
const m = await mapAgent(ir);
for (const n of m.fidelityNotes) console.log(`[${n.status}] ${n.component}: ${n.detail.slice(0, 240)}`);
process.exit(0);
