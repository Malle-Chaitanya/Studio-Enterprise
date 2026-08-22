/** Which of the two agents just migrated declared the SharePoint source "TestingPermissions",
 *  and does its IR carry a SharePoint TOOL to read it with? The run reported the source as
 *  "served by live tools"; neither deployed agent lists one, so find out which side is lying. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = (await getDb()
  .collection('stagedAgents')
  .find({ sourceId: { $in: ['9b97b5fc-2c92-4064-a215-9503deeaa109', 'ca57b355-d08b-f111-8076-0022480b19e9'] } })
  .sort({ _id: -1 })
  .limit(2)
  .toArray()) as Array<Record<string, unknown>>;
for (const r of rows) {
  const ir = (r.mapped as { ir?: Record<string, unknown> } | undefined)?.ir ?? {};
  console.log(`\n=== ${String(r.displayName)}  (${String(r.sourceId).slice(0, 8)}) ===`);
  const ks = (ir.knowledgeSources ?? []) as Array<Record<string, unknown>>;
  for (const k of ks) console.log(`  knowledge  kind=${String(k.kind)}  name=${String(k.name ?? k.displayName ?? '?')}`);
  const tools = (ir.agentTools ?? []) as Array<Record<string, unknown>>;
  for (const t of tools) console.log(`  tool       ${String(t.connectorId ?? t.connector)}  ${String(t.operationId ?? t.operation)}`);
}
process.exit(0);
