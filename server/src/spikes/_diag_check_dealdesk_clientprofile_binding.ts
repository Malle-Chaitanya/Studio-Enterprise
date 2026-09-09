/** Find exactly what entity/query the "Get client profile" Dataverse connector tool is
 *  bound to, and what identity it impersonates as, to explain the live 403 Forbidden.
 *  npx tsx src/spikes/_diag_check_dealdesk_clientprofile_binding.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

await connectMongo();
const db = getDb(config.CSGE_DB);

const doc = await db.collection('stagedAgents').findOne(
  { name: /deal desk/i },
  { sort: { stagedAt: -1 } },
);
const tools = (doc as any)?.mapped?.ir?.agentTools ?? [];
for (const t of tools) {
  if (t.kind === 'connector') {
    console.log(JSON.stringify(t, null, 2));
  }
}
process.exit(0);
