/** Knowledge-source set per staged row over time — did the SOURCE change, or did we stop seeing them? */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('stagedAgents')
  .find({ sourceId: process.argv[2] }).sort({ _id: -1 }).limit(8).toArray() as any[];
for (const r of rows) {
  const names = (r.knowledge ?? []).map((k: any) => `${k.kind}:${k.name}`);
  console.log(`${r.stagedAt}  n=${r.knowledgeCount}  ${r.status}`);
  for (const n of names) console.log('     ', n);
}
process.exit(0);
