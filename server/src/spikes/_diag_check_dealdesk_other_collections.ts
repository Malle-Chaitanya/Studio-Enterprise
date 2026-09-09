import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();

for (const col of ['migratedAgentSnapshots', 'rawAgents', 'adkDeployments', 'migrationRuns']) {
  const hits = await db.collection(col).find({ $or: [{ name: /deal desk/i }, { displayName: /deal desk/i }, { agentName: /deal desk/i }] }).toArray();
  console.log(`\n${col} matching "deal desk": ${hits.length}`);
  for (const h of hits.slice(0, 2)) {
    console.log(`  keys: ${Object.keys(h).join(', ')}`);
    const inst = (h as any).instructions ?? (h as any).instruction;
    if (inst) console.log(`  instruction length: ${String(inst).length}, first 200 chars: ${String(inst).slice(0, 200)}`);
  }
}
process.exit(0);
