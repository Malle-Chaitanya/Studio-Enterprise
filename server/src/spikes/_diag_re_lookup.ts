/** Find the reasoningEngine behind a Gemini agentId. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const id = process.argv[2];
const cols = await db.listCollections().toArray();
for (const c of cols) {
  const hit = await db.collection(c.name).findOne({ $or: [
    { geminiAgentId: id }, { agentId: id }, { adkAgentId: id },
  ] } as any) as any;
  if (!hit) continue;
  const keys = Object.keys(hit).filter(k => /engine|reasoning|agentId|name/i.test(k));
  console.log(c.name, JSON.stringify(Object.fromEntries(keys.map(k => [k, hit[k]]))).slice(0, 500));
}
process.exit(0);
