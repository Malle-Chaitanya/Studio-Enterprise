import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const rows = await db.collection('stagedAgents').find({}).limit(80).toArray();
for (const r of rows as Array<Record<string, unknown>>) {
  const mapped = r.mapped as Record<string, unknown> | undefined;
  if (!mapped) continue;
  const ir = mapped.ir as Record<string, unknown> | undefined;
  const tools = (ir?.tools ?? []) as Array<Record<string, unknown>>;
  if (tools.length) {
    console.log('mapped keys:', Object.keys(mapped).join(', '));
    console.log('mapped.ir keys:', Object.keys(ir ?? {}).join(', '));
    console.log(`\n"${String(r.name)}" has ${tools.length} tool(s); first 3:`);
    for (const t of tools.slice(0, 3)) console.log('  ' + JSON.stringify(t).slice(0, 300));
    break;
  }
}
process.exit(0);
