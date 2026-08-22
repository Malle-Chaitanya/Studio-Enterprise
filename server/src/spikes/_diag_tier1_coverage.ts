/**
 * For the connectors we intend to be PERFECT, what do real agents actually ask of them —
 * and is each of those operations covered?
 *
 * "Perfect" cannot be asserted against a swagger surface: `office365` alone exposes 143
 * operations and nobody calls most of them (see ledger 1.42, which sized the same question at
 * 340 operations and measured the real answer as 1). The only number that matters is what the
 * customer's staged agents REFERENCE, so that is what this counts.
 *
 * Output is the gap list: per connector, the operations real agents use, and whether a
 * purpose-built tool exists for each. Anything unmatched is either work to do or a loss to
 * declare — but it is never a surprise at inference time, which is what it is today.
 *
 *   cd server && npx tsx src/spikes/_diag_tier1_coverage.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { findEquivalence, surfaceForConnector } from '../connectors/equivalence.js';
import { findCoverage } from '../connectors/coverage.js';

/** The set this project has committed to getting right. */
const TIER1 = [
  'shared_teams', 'shared_googlechat', 'shared_outlook', 'shared_office365',
  'shared_googledrive', 'shared_confluence', 'shared_jira',
  'shared_sharepointonline', 'shared_onedrive',
  'shared_hubspot', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspotcrm',
  // Found on a real agent by _diag_connector_census.ts, NOT by anyone reading this list.
  // A hand-written list can only have gaps in connectors someone already thought of, which
  // is why the census exists and why its findings get added back here.
  'shared_hubspotcms',
];

await connectMongo();
const db = getDb();

// Every staged agent ever extracted, across every run — the widest real sample available.
const staged = await db.collection('stagedAgents').find({}).toArray();
console.log(`${staged.length} staged ROW(s) on record`);

// connectorId -> operationId -> the set of DISTINCT AGENTS that call it.
//
// This was a plain counter, and every number it produced was wrong. `stagedAgents` holds one
// row per agent PER RUN, and this tenant has re-extracted dozens of times, so 151 rows are 64
// agents. Counting rows inflated every figure by a per-connector factor, and those figures
// were what got used to prioritise. Key on the agent's own id so re-extraction cannot move
// the number.
const usage = new Map<string, Map<string, Set<string>>>();
const agentKeys = new Set<string>();
for (const row of staged as Array<Record<string, unknown>>) {
  // sourceId is the Dataverse id and is stable across runs; displayName is the fallback for
  // rows staged before it was recorded. A row with neither would collide with every other
  // such row, so give it its own key off _id rather than silently merging them.
  const agentKey = String(row.sourceId ?? row.displayName ?? `_id:${String(row._id)}`);
  agentKeys.add(agentKey);
  // agentTools under mapped.ir — NOT ir.tools, which does not exist on a staged row. The
  // first version of this spike read the wrong path and reported "not referenced by any
  // staged agent" for all thirteen connectors, which would have read as "nothing to do".
  const mapped = row.mapped as { ir?: { agentTools?: Array<Record<string, unknown>> } } | undefined;
  for (const t of mapped?.ir?.agentTools ?? []) {
    const connectorId = String(t.connectorId ?? t.connector ?? '');
    const operationId = String(t.operationId ?? t.operation ?? '');
    if (!connectorId || !operationId) continue;
    const m = usage.get(connectorId) ?? new Map<string, Set<string>>();
    const seen = m.get(operationId) ?? new Set<string>();
    seen.add(agentKey);
    m.set(operationId, seen);
    usage.set(connectorId, m);
  }
}

console.log(`${agentKeys.size} DISTINCT agent(s) - a row is per-agent-per-run\n`);

let totalOps = 0;
let coveredOps = 0;
const gaps: Array<{ connector: string; op: string; agents: number }> = [];

for (const connectorId of TIER1) {
  const def = REGISTRY_BY_ID.get(connectorId);
  const ops = usage.get(connectorId);
  if (!ops?.size) {
    console.log(`${(def?.name ?? connectorId).padEnd(34)} — not referenced by any staged agent`);
    continue;
  }
  console.log(`\n=== ${def?.name ?? connectorId} — ${ops.size} distinct operation(s) used ===`);
  const surface = surfaceForConnector(connectorId);
  for (const [op, agents] of [...ops].sort((a, b) => b[1].size - a[1].size)) {
    const n = agents.size;
    totalOps++;
    // The equivalence table is the only place that states, per operation, what the migrated
    // agent can really do. No table entry means nobody has judged this operation at all —
    // which is materially different from judging it and finding it lost.
    // TWO tables answer this, for two different kinds of move, and consulting only one
    // reported finished work as UNJUDGED:
    //   equivalence.ts - CROSS-vendor (Teams->Chat, Outlook->Gmail), keyed by M365Surface.
    //   coverage.ts    - SAME-vendor (Jira->Jira), keyed by connectorId.
    // surfaceForConnector returns null for Drive/Jira/Confluence/HubSpot, so before this
    // fix those connectors were unjudged BY CONSTRUCTION and the gap count was noise.
    const cov = findCoverage(connectorId, op);
    const eq = surface ? findEquivalence(surface, op) : undefined;
    const judged = cov ?? eq;
    // TWO PATHS PER OPERATION, and collapsing them to one verdict misreports both.
    //
    // For a Microsoft surface the customer chooses: move to the Google equivalent, or keep
    // the Microsoft one and just move the agent. `fidelity` grades the FIRST; `graph` grades
    // the second. GetTeam is the clearest case — Google Chat has no team object, so it is
    // genuinely `lost` there, while on the keep-Teams path it works unchanged and is proven.
    // Reporting only 'lost' listed it as an 11-agent gap with nothing to do about it, which
    // is both wrong and demoralising; reporting only 'proven' would hide a real loss.
    const googleVerdict = !judged
      ? 'UNJUDGED'
      : judged.fidelity === 'lost'
        ? 'lost'
        : judged.verified
          ? 'proven'
          : judged.fidelity;
    const graphVerdict = eq?.graph
      ? eq.graph.verified
        ? 'proven'
        : eq.graph.tool
          ? 'built, unproven'
          : 'mapped only'
      : undefined;
    // A gap is an operation with NO working path. If either side is proven, the customer has
    // a route — the other side's loss is a fidelity note, not a hole.
    const verdict =
      googleVerdict === 'proven' || graphVerdict === 'proven'
        ? 'proven'
        : googleVerdict;
    const detail =
      graphVerdict && graphVerdict !== googleVerdict
        ? `${googleVerdict} (google) / ${graphVerdict} (graph)`
        : googleVerdict;
    // 'exact' with no live call is a claim, not a proof - judged, but not covered.
    if (verdict === 'proven') coveredOps++;
    if (verdict === 'UNJUDGED' || verdict === 'lost') gaps.push({ connector: def?.name ?? connectorId, op, agents: n });
    console.log(`  ${String(n).padStart(3)} agent(s)  ${op.padEnd(38)} ${detail}`);
  }
}

console.log(`\n\n================ GAP SUMMARY ================`);
console.log(`${totalOps} operation(s) used across Tier-1 connectors`);
console.log(
  `${coveredOps} proven live, ${gaps.length} unjudged or lost, ` +
    `${totalOps - coveredOps - gaps.length} judged but not proven live\n`,
);
const byConnector = new Map<string, number>();
for (const g of gaps) byConnector.set(g.connector, (byConnector.get(g.connector) ?? 0) + 1);
for (const [c, n] of [...byConnector].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} gap(s)  ${c}`);
}
console.log('\nTop gaps by how many agents are affected:');
for (const g of gaps.sort((a, b) => b.agents - a.agents).slice(0, 20)) {
  console.log(`  ${String(g.agents).padStart(3)} agent(s)  ${g.connector} :: ${g.op}`);
}
process.exit(0);
