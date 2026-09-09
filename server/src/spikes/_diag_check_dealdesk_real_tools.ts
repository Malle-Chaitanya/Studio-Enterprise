/** Ground truth: what tools does the REAL Deal Desk agent actually have, extracted live
 *  from Dataverse right now? The deployed agent's instruction claims "GetClientProfile
 *  from hubspot" and "Microsoft Dataverse" access — is that real, or an LLM invention?
 *  npx tsx src/spikes/_diag_check_dealdesk_real_tools.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId || !s.dvOrgUrl) throw new Error('NO_USABLE_SESSION');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const bots = await listBots(s.dvOrgUrl, token);
const bot = bots.find((b) => b.name.trim().toLowerCase() === 'deal desk');
if (!bot) throw new Error('Deal Desk not found');
const ir = await extractAgent(s.dvOrgUrl, token, bot);

console.log(`agentTools: ${ir.agentTools?.length ?? 0}`);
for (const t of ir.agentTools ?? []) {
  console.log(`  - name="${t.name}" kind=${t.kind} connectorId=${t.connectorId} operationId=${t.operationId} flowId=${t.flowId ?? '-'} sourceTopic=${t.sourceTopic ?? '-'}`);
}
console.log(`\nflows: ${ir.flows?.map((f) => f.name).join(', ')}`);
console.log(`\nunmapped entries:`);
for (const u of ir.unmapped) console.log(`  - ${u}`);
process.exit(0);
