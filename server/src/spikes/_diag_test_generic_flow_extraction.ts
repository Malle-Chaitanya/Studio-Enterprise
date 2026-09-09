/** Run the new GENERIC extractAgent flow extraction against the real Deal Desk agent
 *  (4 real flows) and confirm it reproduces what we already proved by hand — no
 *  per-flow special-casing, this is the production extraction path.
 *  npx tsx src/spikes/_diag_test_generic_flow_extraction.ts */
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
console.log(`Agent: ${ir.name}`);
console.log(`agentTools: ${ir.agentTools?.length ?? 0}`);
console.log(`flows extracted: ${ir.flows?.length ?? 0}\n`);

for (const f of ir.flows ?? []) {
  console.log(`=== ${f.name} (id=${f.id}, owner tool="${f.ownerToolName}") ===`);
  console.log(`  trigger: type=${f.trigger?.type} kind=${f.trigger?.kind}`);
  for (const p of f.trigger?.inputSchema ?? []) {
    console.log(`    input "${p.name}" displayName="${p.displayName}" dataType=${p.dataType} required=${p.required}`);
  }
  console.log(`  actions (${f.actions.length}):`);
  for (const a of f.actions) {
    let extra = '';
    if (a.compose) extra = ' [compose]';
    if (a.response) extra = ` [response statusCode=${a.response.statusCode}]`;
    if (a.connector) extra = ` [connector ref=${a.connector.connectionReferenceName} op=${a.connector.operationId}]`;
    if (a.branches) extra = ` [branches: ${a.branches.map((b) => `${b.label}(${b.actions.length})`).join(', ')}]`;
    console.log(`    - ${a.id} type=${a.type}${extra} runAfter=${JSON.stringify(a.runAfter)}`);
  }
  console.log(`  connectionReferences: ${f.connectionReferences.map((c) => `${c.name}->${c.connectorId}`).join(', ') || 'none'}`);
  if (f.unmapped.length) console.log(`  unmapped: ${f.unmapped.join(' | ')}`);
  console.log();
}

console.log('--- agent-level unmapped entries mentioning flows ---');
for (const u of ir.unmapped) if (/flow/i.test(u)) console.log(`  ${u}`);
process.exit(0);
