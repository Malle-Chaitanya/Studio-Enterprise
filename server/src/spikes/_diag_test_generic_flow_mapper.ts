/** Run the new GENERIC translateFlow() against all 4 real, live-extracted Deal Desk
 *  flows and print the result + fidelity notes for inspection, before trusting it to
 *  upload anything. npx tsx src/spikes/_diag_test_generic_flow_mapper.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { translateFlow } from '../services/flowMapper.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId || !s.dvOrgUrl) {
  console.log('NO_USABLE_SESSION');
  process.exit(0);
}
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const bots = await listBots(s.dvOrgUrl, token);
const bot = bots.find((b) => b.name.trim().toLowerCase() === 'deal desk');
if (!bot) {
  console.log('Deal Desk not found');
  process.exit(0);
}
const ir = await extractAgent(s.dvOrgUrl, token, bot);

for (const flow of ir.flows ?? []) {
  console.log(`\n${'='.repeat(70)}\nTRANSLATING: ${flow.name}`);
  const result = translateFlow(flow, { integrationName: `${flow.name.replace(/\W/g, '')}_Generic` });
  console.log(`inputParameters: ${result.inputParameters.map((p) => `${p.name}(${p.displayName})->${p.dataType}`).join(', ')}`);
  console.log(`authConfigsNeeded: ${JSON.stringify(result.authConfigsNeeded)}`);
  console.log('fidelityNotes:');
  for (const n of result.fidelityNotes) console.log(`  [${n.status}] ${n.component}: ${n.detail}`);
  console.log('\nintegrationDefinition:');
  console.log(JSON.stringify(result.integrationDefinition, null, 2));
}
process.exit(0);
