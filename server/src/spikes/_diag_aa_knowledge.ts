/** What AA's Confluence knowledge source actually records. Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const r = await getDb().collection('agentIRCache').findOne<any>({ sourceId: 'bdf9b817-9b90-f111-b8da-0022480b1f83' });
if (!r) { console.log('no cached IR'); process.exit(0); }
for (const k of r.ir?.knowledgeSources ?? []) console.log(JSON.stringify(k).slice(0, 900), '\n---');
const mcp = (r.ir?.agentTools ?? []).filter((t: any) => t.kind === 'mcp-server');
console.log(`\nMCP tools: ${mcp.length}`);
for (const t of mcp) console.log(`  ${t.name} connector=${t.connectorId} sel=${t.mcp?.toolSelection} tools=${JSON.stringify(t.mcp?.tools)}`);
console.log(`other tools: ${(r.ir?.agentTools ?? []).filter((t: any) => t.kind !== 'mcp-server').map((t: any) => `${t.kind}:${t.name}`).join(', ')}`);
process.exit(0);
