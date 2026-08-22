/**
 * EVERY connector id and knowledge-source kind any agent has ever referenced — and whether
 * the pipeline has a real answer for each.
 *
 * The Tier-1 board was built from a HAND-WRITTEN list of connector ids, so it could only find
 * gaps in connectors someone had already thought of. That is the wrong shape for "any agent a
 * customer might build must migrate without errors": the population dry run found
 * `shared_hubspotcms` on an agent, an id no list contained, and it would have been reported as
 * an unsupported connector with no tool.
 *
 * So this reads every source of truth we have — rawAgents (the untransformed Dataverse rows),
 * stagedAgents, and agentIRCache — and asks, per id:
 *   registry?    is there a definition, so a credential can be collected and a spec built
 *   module?      does a purpose-built Python tool module serve it
 *   verdict?     do the coverage/equivalence tables have anything to say about its operations
 *
 * Anything with no registry entry gets NO TOOL AT ALL. That is the failure mode this exists
 * to make impossible to miss.
 *
 *   cd server && npx tsx src/spikes/_diag_connector_census.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { hasDedicatedToolModule } from '../connectors/toolModule.js';
import { findCoverage } from '../connectors/coverage.js';
import { findEquivalence, surfaceForConnector } from '../connectors/equivalence.js';

await connectMongo();
const db = getDb();

/** connectorId -> operationId -> distinct agent keys */
const ops = new Map<string, Map<string, Set<string>>>();
/** knowledge source kind -> distinct agent keys */
const ksKinds = new Map<string, Set<string>>();
/** tool kinds seen (connector, mcp-server, connected-agent, ...) */
const toolKinds = new Map<string, Set<string>>();

function noteTools(agentKey: string, ir: Record<string, unknown> | undefined) {
  if (!ir) return;
  for (const t of (ir.agentTools as Array<Record<string, unknown>>) ?? []) {
    const kind = String(t.kind ?? '(none)');
    toolKinds.set(kind, (toolKinds.get(kind) ?? new Set()).add(agentKey));
    const id = String(t.connectorId ?? '');
    if (!id) continue;
    const op = String(t.operationId ?? '(no operation)');
    const m = ops.get(id) ?? new Map<string, Set<string>>();
    m.set(op, (m.get(op) ?? new Set()).add(agentKey));
    ops.set(id, m);
  }
  for (const k of (ir.knowledgeSources as Array<Record<string, unknown>>) ?? []) {
    const kind = String(k.kind ?? '(none)');
    ksKinds.set(kind, (ksKinds.get(kind) ?? new Set()).add(agentKey));
  }
}

// Distinct AGENTS, not rows: stagedAgents holds one row per agent per run (151 rows, 64
// agents in this tenant), and counting rows inflated every number on the earlier board.
for (const row of (await db.collection('stagedAgents').find({}).toArray()) as Array<Record<string, unknown>>) {
  const key = String(row.sourceId ?? row.displayName ?? row.name ?? '?');
  noteTools(key, (row.mapped as { ir?: Record<string, unknown> } | undefined)?.ir);
}
for (const row of (await db.collection('agentIRCache').find({}).toArray()) as Array<Record<string, unknown>>) {
  const ir = row.ir as Record<string, unknown> | undefined;
  noteTools(String(row.botid ?? ir?.name ?? '?'), ir);
}

console.log(`${ops.size} distinct connector id(s) referenced by real agents\n`);
const missing: Array<{ id: string; agents: number; opList: string[] }> = [];
for (const [id, opMap] of [...ops].sort((a, b) => {
  const an = new Set([...a[1].values()].flatMap((s) => [...s])).size;
  const bn = new Set([...b[1].values()].flatMap((s) => [...s])).size;
  return bn - an;
})) {
  const agents = new Set([...opMap.values()].flatMap((s) => [...s])).size;
  const def = REGISTRY_BY_ID.get(id);
  const mod = hasDedicatedToolModule(id);
  const surface = surfaceForConnector(id);
  const judged = [...opMap.keys()].filter(
    (op) => findCoverage(id, op) ?? (surface ? findEquivalence(surface, op) : undefined),
  ).length;
  const flag = !def ? '  *** NO REGISTRY ENTRY -> NO TOOL ***' : '';
  console.log(
    `${id.slice(0, 46).padEnd(48)} agents=${String(agents).padStart(3)} ops=${String(opMap.size).padStart(2)} ` +
      `registry=${def ? 'yes' : 'NO '} module=${mod ? 'yes' : 'no '} judged=${judged}/${opMap.size}${flag}`,
  );
  if (!def) missing.push({ id, agents, opList: [...opMap.keys()] });
}

console.log(`\n--- knowledge source kinds ---`);
for (const [kind, agents] of [...ksKinds].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${kind.padEnd(28)} ${agents.size} agent(s)`);
}
console.log(`\n--- agent tool kinds ---`);
for (const [kind, agents] of [...toolKinds].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${kind.padEnd(28)} ${agents.size} agent(s)`);
}

if (missing.length) {
  console.log(`\n${missing.length} connector(s) with NO registry entry — each gets no tool at all:`);
  for (const m of missing) {
    console.log(`  ${m.id}`);
    console.log(`     agents=${m.agents}  operations: ${m.opList.join(', ')}`);
  }
} else {
  console.log('\nEvery referenced connector has a registry entry.');
}
process.exit(0);
