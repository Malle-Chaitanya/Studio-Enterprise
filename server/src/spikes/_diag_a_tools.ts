import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const r = await getDb().collection('agentIRCache').findOne<any>({ sourceId: 'bdf9b817-9b90-f111-b8da-0022480b1f83' });
const ir = r?.ir; if (!ir) { console.log('not cached'); process.exit(0); }
console.log(`name=${ir.displayName ?? ir.name}`);
for (const t of ir.agentTools ?? []) {
  if (t.kind === 'mcp-server') console.log(`MCP   ${t.name} -> ${JSON.stringify(t.mcp?.tools)}`);
  else console.log(`${t.kind.padEnd(16)} ${t.name}  [${t.connectorId ?? '-'} / ${t.operationId ?? '-'}]`);
}
for (const k of ir.knowledgeSources ?? []) console.log(`KS ${k.kind} "${k.name}" -> ${k.classification?.strategy}`);
process.exit(0);
