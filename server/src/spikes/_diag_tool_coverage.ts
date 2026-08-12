/**
 * Of every connector operation these agents actually use, how many can we call for real?
 *
 * "We support 1134 operations" is a statement about our fixtures, not about this customer.
 * The number that matters is: of the operations THEIR agents reference, how many bind to a
 * real vendor API call, how many are refused, and why. This runs the same
 * `buildBoundToolSpecs` the deploy path runs, over every agent in both environments.
 *
 * Read-only. Prints operation ids and reasons; never credential values.
 *
 * npx tsx src/spikes/_diag_tool_coverage.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as
  { tenantId?: string; environments?: Array<{ url: string; name: string; id: string }> } | null;
const tenantId = cache!.tenantId!;
const envs = (cache!.environments ?? []).filter((e) => /orga243378d|org32322095/.test(e.url));

let agentsWithTools = 0;
let totalTools = 0;
const byConnector = new Map<string, { bound: number; refused: number }>();
const refusals: string[] = [];
const boundOps = new Set<string>();
const kinds = new Map<string, number>();
const noteStatus = new Map<string, number>();
const other: string[] = [];
const unbound: string[] = [];

for (const env of envs) {
  const token = await clientCredsToken(tenantId, env.url);
  const bots = await listBots(env.url, token);
  for (const bot of bots) {
    let ir;
    try {
      ir = await extractAgent(env.url, token, bot);
    } catch {
      continue;
    }
    const tools = ir.agentTools ?? [];
    if (!tools.length) continue;
    agentsWithTools++;
    totalTools += tools.length;
    for (const t of tools) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);

    const build = await buildBoundToolSpecs(
      ir,
      { tenantId, environmentId: env.id, scope: `ms-${tenantId}` },
      { dataverseOrgUrl: env.url },
    ).catch(() => null);
    if (!build) continue;

    for (const [connectorId, specs] of build.byConnector) {
      const e = byConnector.get(connectorId) ?? { bound: 0, refused: 0 };
      e.bound += specs.length;
      byConnector.set(connectorId, e);
      for (const s of specs) boundOps.add(`${connectorId}:${s.operationId}`);
    }
    for (const n of build.notes) {
      noteStatus.set(n.status, (noteStatus.get(n.status) ?? 0) + 1);
      if (n.status === 'lost') refusals.push(`${ir.name} — ${n.component}: ${n.detail.slice(0, 110)}`);
      else other.push(`[${n.status}] ${n.component}: ${n.detail.slice(0, 120)}`);
    }
    // Connector tools that produced NO bound spec and NO note are the real blind spot:
    // silently absent is worse than refused, because nothing tells the customer.
    const boundIds = new Set([...build.byConnector.values()].flat().map((s2) => s2.operationId));
    for (const t of tools.filter((x) => x.kind === 'connector')) {
      if (t.operationId && !boundIds.has(t.operationId)) {
        unbound.push(`${t.connectorId ?? '(no connector id)'}:${t.operationId}`);
      }
    }
  }
}

console.log(`\n══ tools across the tenant`);
console.log(`  agents with at least one tool: ${agentsWithTools}`);
console.log(`  total tools referenced:        ${totalTools}`);
console.log(`  tool kinds: ${[...kinds.entries()].map(([k, n]) => `${k}=${n}`).join(', ')}`);

console.log(`\n══ operations that bind to a real vendor API call`);
let bound = 0;
for (const [c, e] of [...byConnector.entries()].sort((a, b) => b[1].bound - a[1].bound)) {
  console.log(`  ${c.padEnd(38)} ${e.bound}`);
  bound += e.bound;
}
console.log(`  ${'TOTAL'.padEnd(38)} ${bound}  (${boundOps.size} distinct operations)`);

console.log(`\n══ refused, with the reason (first 12)`);
for (const r of refusals.slice(0, 12)) console.log(`  ${r}`);
console.log(`  ${refusals.length} refusal(s) total`);
console.log(`
══ note statuses: ${[...noteStatus.entries()].map(([k, n]) => `${k}=${n}`).join(', ') || '(none)'}`);
const byOp = new Map<string, number>();
for (const u of unbound) byOp.set(u, (byOp.get(u) ?? 0) + 1);
console.log(`
══ connector tools that produced NO bound call: ${unbound.length}`);
for (const [op, n] of [...byOp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(3)}x ${op}`);
console.log(`
══ other notes (first 6)`);
for (const o of other.slice(0, 6)) console.log(`  ${o}`);
process.exit(0);
