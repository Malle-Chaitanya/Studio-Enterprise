/** What connectorId did the ACTUAL staged migration run store for the Dataverse tool
 *  (not a fresh re-extraction)? Read-only. npx tsx src/spikes/_diag_check_staged_dealdesk_dataverse.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const row = await getDb()
  .collection('stagedAgents')
  .find({ name: 'Deal Desk' })
  .sort({ $natural: -1 })
  .limit(1)
  .next();
const tools = row?.mapped?.ir?.agentTools ?? [];
console.log(`Staged run: ${row?.runId}`);
for (const t of tools) {
  console.log(`  - name="${t.name}" kind=${t.kind} connectorId=${t.connectorId} operationId=${t.operationId}`);
}
process.exit(0);
