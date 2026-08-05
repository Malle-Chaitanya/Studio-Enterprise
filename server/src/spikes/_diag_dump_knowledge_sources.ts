import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';
import type { AgentIR } from '../types.js';

async function main() {
  const nameQuery = process.argv[2];
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const docs = await db.collection<{ ir: AgentIR }>('agentIRCache')
    .find({ 'ir.name': { $regex: nameQuery, $options: 'i' } }).toArray();
  for (const doc of docs) {
    console.log(`Agent: ${doc.ir.name}`);
    console.log(JSON.stringify(doc.ir.knowledgeSources, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
