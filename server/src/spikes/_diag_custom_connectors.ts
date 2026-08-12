/**
 * What CUSTOM connectors does this tenant have, and which can we call?
 *
 * The answer used to be discovered by accident, one agent at a time, after an id survived
 * three separate parsers. Ask the platform directly instead — across every environment,
 * saying plainly which ones we cannot read and why.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_custom_connectors.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { listCustomConnectors } from '../connectors/customConnectorInventory.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

let totalCustom = 0;
let totalBindable = 0;

for (const env of await discoverEnvironments(tenantId)) {
  const connectors = await listCustomConnectors(tenantId, env.id);
  console.log(`\n${'='.repeat(76)}\n  ${env.name}\n${'='.repeat(76)}`);
  if (connectors === undefined) {
    console.log('  COULD NOT LIST — the admin API refused; a custom connector here would be invisible');
    continue;
  }
  if (!connectors.length) {
    console.log('  no custom connectors in this environment (listed successfully, zero found)');
    continue;
  }

  // Which AGENTS use each one — a connector nobody references needs no credential, and
  // saying "3 agents will lose 4 operations" is the sentence a customer can act on.
  const users = new Map<string, string[]>();
  try {
    const token = await clientCredsToken(tenantId, env.url);
    for (const bot of await listBots(env.url, token)) {
      const ir = await extractAgent(env.url, token, bot).catch(() => null);
      if (!ir) continue;
      for (const t of ir.agentTools ?? []) {
        if (!t.connectorId) continue;
        if (!connectors.some((c) => c.connectorId === t.connectorId)) continue;
        users.set(t.connectorId, [...new Set([...(users.get(t.connectorId) ?? []), ir.name])]);
      }
    }
  } catch {
    console.log('  (could not read agents in this environment — usage column omitted)');
  }

  for (const c of connectors) {
    totalCustom++;
    if (c.bindable) totalBindable++;
    console.log(`\n  ${c.displayName}`);
    console.log(`    id:         ${c.connectorId}`);
    console.log(`    published:  ${c.publisher ?? '?'}${c.createdBy ? ` (${c.createdBy})` : ''} ${c.createdTime?.slice(0, 10) ?? ''}`);
    console.log(`    backend:    ${c.backendHost ?? '(unknown)'}`);
    console.log(`    status:     ${c.bindable ? `BINDABLE — ${c.operationCount} operation(s)` : 'NOT bindable'}`);
    if (c.reason) console.log(`    reason:     ${c.reason}`);
    if (c.policyCount) console.log(`    policies:   ${c.policyCount} — request may be rewritten before it reaches the backend`);
    if (c.operations.length) console.log(`    operations: ${c.operations.join(', ')}`);
    const used = users.get(c.connectorId);
    console.log(`    used by:    ${used?.length ? used.join(', ') : '(no agent in this environment references it)'}`);
  }
}

console.log(`\n${'─'.repeat(76)}`);
console.log(`${totalCustom} custom connector(s) found · ${totalBindable} bindable · ${totalCustom - totalBindable} not`);
process.exit(0);
