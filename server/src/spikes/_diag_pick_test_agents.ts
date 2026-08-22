/**
 * Which agents should a human actually select in the UI to exercise every Tier-1 operation?
 *
 * Greedy set cover over DISTINCT agents (never rows — see ledger 1.52). Answers the practical
 * question "what do I click" instead of leaving it to be guessed from a 64-agent list, and
 * prints the per-agent operation list so a failure points at a known surface.
 *
 *   cd server && npx tsx src/spikes/_diag_pick_test_agents.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

const TIER1 = new Set([
  'shared_teams', 'shared_googlechat', 'shared_outlook', 'shared_office365',
  'shared_googledrive', 'shared_confluence', 'shared_jira',
  'shared_sharepointonline', 'shared_onedrive',
  'shared_hubspot', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspotcrm',
  'shared_hubspotcms',
]);

await connectMongo();
const staged = (await getDb().collection('stagedAgents').find({}).toArray()) as Array<Record<string, unknown>>;

/** agentKey -> {name, ops:Set<"connector::op">, envs:Set, ks:Set} — newest row per agent wins. */
const agents = new Map<string, { name: string; ops: Set<string>; ks: Set<string>; custom: Set<string> }>();
for (const row of staged) {
  const key = String(row.sourceId ?? row.displayName ?? `_id:${String(row._id)}`);
  const mapped = row.mapped as
    | { ir?: { agentTools?: Array<Record<string, unknown>>; knowledgeSources?: Array<Record<string, unknown>> } }
    | undefined;
  const a = agents.get(key) ?? {
    name: String(row.displayName ?? mapped?.ir?.['displayName'] ?? key),
    ops: new Set<string>(),
    ks: new Set<string>(),
    custom: new Set<string>(),
  };
  for (const t of mapped?.ir?.agentTools ?? []) {
    const c = String(t.connectorId ?? t.connector ?? '');
    const op = String(t.operationId ?? t.operation ?? '');
    if (!c || !op) continue;
    if (TIER1.has(c)) a.ops.add(`${c}::${op}`);
    else a.custom.add(c);
  }
  for (const k of mapped?.ir?.knowledgeSources ?? []) a.ks.add(String(k.kind ?? k.type ?? 'unknown'));
  agents.set(key, a);
}

const universe = new Set<string>();
for (const a of agents.values()) for (const o of a.ops) universe.add(o);
console.log(`${agents.size} distinct agent(s); ${universe.size} Tier-1 operation(s) to cover\n`);

// Greedy cover. Not provably minimal, but the point is a SHORT click-list, not optimality.
const remaining = new Set(universe);
const picked: Array<{ name: string; gained: string[]; a: (typeof agents extends Map<string, infer V> ? V : never) }> = [];
while (remaining.size) {
  let best: { key: string; gain: string[] } | undefined;
  for (const [key, a] of agents) {
    const gain = [...a.ops].filter((o) => remaining.has(o));
    if (!best || gain.length > best.gain.length) best = { key, gain };
  }
  if (!best || !best.gain.length) break;
  const a = agents.get(best.key)!;
  picked.push({ name: a.name, gained: best.gain, a });
  for (const o of best.gain) remaining.delete(o);
  agents.delete(best.key);
}

console.log(`=== SELECT THESE ${picked.length} AGENT(S) — covers all ${universe.size} operations ===\n`);
picked.forEach((p, i) => {
  console.log(`${i + 1}. ${p.name}`);
  const byConn = new Map<string, string[]>();
  for (const o of p.gained.sort()) {
    const [c, op] = o.split('::');
    byConn.set(c, [...(byConn.get(c) ?? []), op]);
  }
  for (const [c, ops] of byConn) {
    console.log(`     ${(REGISTRY_BY_ID.get(c)?.name ?? c).padEnd(34)} ${ops.join(', ')}`);
  }
  if (p.a.ks.size) console.log(`     knowledge: ${[...p.a.ks].join(', ')}`);
  if (p.a.custom.size) console.log(`     custom/non-tier1: ${[...p.a.custom].join(', ')}`);
});
if (remaining.size) console.log(`\nUNCOVERED (${remaining.size}): ${[...remaining].join(', ')}`);
process.exit(0);
