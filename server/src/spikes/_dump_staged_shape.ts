import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const r = await db.collection('stagedAgents').find({}).sort({ $natural: -1 }).limit(1).next() as Record<string, unknown> | null;
console.log('stagedAgent keys:', Object.keys(r ?? {}).join(', '));
const ir = r?.ir as Record<string, unknown> | undefined;
console.log('ir keys:', Object.keys(ir ?? {}).join(', '));
for (const k of Object.keys(ir ?? {})) {
  const v = (ir as Record<string, unknown>)[k];
  if (Array.isArray(v) && v.length) console.log(`  ${k}: ${v.length} item(s) -> ${JSON.stringify(v[0]).slice(0, 220)}`);
}
process.exit(0);
