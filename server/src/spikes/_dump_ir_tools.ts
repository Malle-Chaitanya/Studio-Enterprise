import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const rows = await db.collection('stagedAgents').find({}).limit(60).toArray();
for (const r of rows as Array<Record<string, unknown>>) {
  const ir = r.ir as Record<string, unknown> | undefined;
  const tools = (ir?.tools ?? []) as Array<Record<string, unknown>>;
  if (tools.length) {
    console.log('stagedAgent keys:', Object.keys(r).join(', '));
    console.log('ir keys:', Object.keys(ir ?? {}).join(', '));
    console.log(`\nfirst 3 tools of "${String(ir?.name)}":`);
    for (const t of tools.slice(0, 3)) console.log(JSON.stringify(t).slice(0, 400));
    break;
  }
}
process.exit(0);
