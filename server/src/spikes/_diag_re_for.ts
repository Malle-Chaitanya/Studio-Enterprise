/** Reasoning engine id for the newest migration result of a named agent. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
for (const c of ['migrationResults', 'adkDeployments', 'adkAgents']) {
  const rows = await db.collection(c).find({ $or: [{ name: process.argv[2] }, { displayName: process.argv[2] }, { agentName: process.argv[2] }] })
    .sort({ _id: -1 }).limit(2).toArray() as any[];
  if (!rows.length) continue;
  console.log(`== ${c}`);
  for (const r of rows) {
    const keys = Object.keys(r).filter(k => /engine|agentId|reasoning|verified|deployed/i.test(k));
    console.log('  ', JSON.stringify(Object.fromEntries(keys.map(k => [k, r[k]]))).slice(0, 400));
  }
}
process.exit(0);
