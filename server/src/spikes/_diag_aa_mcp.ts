/** Exactly what AA's MCP tools bind to. Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('agentIRCache').find({}).toArray();
for (const r of rows as any[]) {
  const ir = r.ir; if (!ir) continue;
  const mcp = (ir.agentTools ?? []).filter((t: any) => t.kind === 'mcp-server');
  if (!mcp.length) continue;
  console.log(`\n${ir.displayName ?? ir.name}  (env=${r.envUrl})`);
  for (const t of mcp) {
    console.log(`  tool=${t.name} connectorId=${t.connectorId ?? '(none)'} sel=${t.mcp?.toolSelection ?? '?'} url=${t.mcp?.serverUrl ?? '(none)'}`);
    console.log(`    declared: ${JSON.stringify(t.mcp?.tools ?? [])}`);
  }
}
process.exit(0);
