/** Which connectors used by real agents have no registry entry? Those are the custom ones. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

await connectMongo();
const rows = await getDb().collection('agentIRCache').find({}).toArray();
const byConn = new Map<string, Set<string>>();
for (const r of rows) {
  const ir = (r as any).ir;
  for (const t of ir?.agentTools ?? []) {
    const id = t.connectorId;
    if (!id) continue;
    if (!byConn.has(id)) byConn.set(id, new Set());
    byConn.get(id)!.add(ir.displayName ?? ir.name ?? '?');
  }
}
for (const [id, agents] of [...byConn].sort()) {
  const kind = REGISTRY_BY_ID.has(id) ? 'REGISTRY' : 'CUSTOM  ';
  console.log(`${kind} ${id}  <- ${[...agents].join(', ')}`);
}
process.exit(0);
