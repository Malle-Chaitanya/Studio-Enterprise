import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('stagedAgents').find<any>({}).sort({ _id: -1 }).limit(6).toArray();
for (const r of rows) {
  console.log(`${(r.name ?? '?').padEnd(34)} status=${r.status} runId=${r.runId} fidelity=${r.fidelity === undefined ? 'UNDEFINED' : Array.isArray(r.fidelity) ? `array(${r.fidelity.length})` : typeof r.fidelity}  mapped=${r.mapped === undefined ? 'UNDEFINED' : 'present'} knowledge=${r.knowledge === undefined ? 'UNDEFINED' : Array.isArray(r.knowledge) ? r.knowledge.length : typeof r.knowledge}`);
}
process.exit(0);
