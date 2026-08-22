/**
 * Which HubSpot connector ids do staged agents ACTUALLY declare, and which operations?
 *
 * The Tier-1 board was built from a hand-written list of connector ids, so it could only ever
 * find gaps in connectors someone had already thought of. The population dry run found
 * `shared_hubspotcms` on 15 agents — an id that list never contained.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

await connectMongo();
const staged = (await getDb().collection('stagedAgents').find({}).toArray()) as Array<Record<string, unknown>>;
const byId = new Map<string, Map<string, Set<string>>>();
for (const row of staged) {
  const name = String(row.displayName ?? row.name ?? '?');
  const ir = (row.mapped as { ir?: { agentTools?: Array<Record<string, unknown>> } } | undefined)?.ir;
  for (const t of ir?.agentTools ?? []) {
    const id = String(t.connectorId ?? '');
    if (!/hubspot/i.test(id)) continue;
    const ops = byId.get(id) ?? new Map<string, Set<string>>();
    const op = String(t.operationId ?? '(none)');
    ops.set(op, (ops.get(op) ?? new Set()).add(name));
    byId.set(id, ops);
  }
}
for (const [id, ops] of byId) {
  const def = REGISTRY_BY_ID.get(id);
  console.log(`\n${id}  ${def ? `-> ${def.name}` : '*** NOT IN REGISTRY ***'}`);
  for (const [op, names] of [...ops].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`   ${String(names.size).padStart(3)} agent(s)  ${op}`);
  }
}
process.exit(0);
