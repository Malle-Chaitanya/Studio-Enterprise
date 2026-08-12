/**
 * The four connectors we are committing to first: Confluence, Jira, HubSpot, Dataverse.
 *
 * Which agents use them, which operations, and — running the real binder — which of those
 * operations would actually produce a call today. This is the work list for "make these
 * four work end to end", so it reports per AGENT (what a customer migrates) rather than
 * per operation.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_target_four.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';

/** Match on the connector id AND on the operation shape, because the extraction bug
 *  (topic-embedded actions) loses the connector id and leaves only the operation name. */
const TARGETS: Record<string, RegExp> = {
  Confluence: /confluence/i,
  Jira: /jira/i,
  HubSpot: /hubspot/i,
  Dataverse: /commondataservice|dynamicscrm|dataverse|WithOrganization$/i,
};

function targetOf(connectorId: string | undefined, operationId: string | undefined): string | null {
  for (const [name, re] of Object.entries(TARGETS)) {
    if ((connectorId && re.test(connectorId)) || (operationId && re.test(operationId))) return name;
  }
  return null;
}

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as
  { tenantId?: string; environments?: Array<{ url: string; name: string; id: string }> } | null;
const tenantId = cache!.tenantId!;
const envs = (cache!.environments ?? []).filter((e) => /orga243378d|org32322095/.test(e.url));

interface AgentRow {
  env: string;
  name: string;
  targets: Set<string>;
  ops: number;
  bound: number;
  refused: number;
  dropped: string[];
}
const rows: AgentRow[] = [];

for (const env of envs) {
  const token = await clientCredsToken(tenantId, env.url);
  for (const bot of await listBots(env.url, token)) {
    let ir;
    try {
      ir = await extractAgent(env.url, token, bot);
    } catch {
      continue;
    }
    const tools = (ir.agentTools ?? []).filter((t) => t.kind === 'connector');
    const relevant = tools.filter((t) => targetOf(t.connectorId, t.operationId));
    // Confluence also arrives as a KNOWLEDGE source, not a tool — an agent grounded on
    // Confluence spaces has no connector tool at all and would be invisible here.
    const cfKnowledge = (ir.knowledgeSources ?? []).filter(
      (k) => Array.isArray(k.confluenceSpaceNames) && k.confluenceSpaceNames.length > 0,
    );
    if (!relevant.length && !cfKnowledge.length) continue;

    const build = await buildBoundToolSpecs(
      ir,
      { tenantId, environmentId: env.id, scope: `ms-${tenantId}` },
      { dataverseOrgUrl: env.url },
    ).catch(() => null);
    const boundIds = new Set(
      [...(build?.byConnector.values() ?? [])].flat().map((s) => s.operationId),
    );
    const targets = new Set<string>(relevant.map((t) => targetOf(t.connectorId, t.operationId)!));
    if (cfKnowledge.length) targets.add('Confluence');

    rows.push({
      env: env.name,
      name: ir.name,
      targets,
      ops: relevant.length,
      bound: relevant.filter((t) => t.operationId && boundIds.has(t.operationId)).length,
      refused: (build?.notes ?? []).filter((n) => n.status === 'lost').length,
      dropped: relevant
        .filter((t) => t.operationId && !boundIds.has(t.operationId))
        .map((t) => `${t.connectorId ?? '(no id)'}:${t.operationId}`),
    });
  }
}

rows.sort((a, b) => b.bound - a.bound || b.ops - a.ops);
console.log(`\n══ ${rows.length} agent(s) using Confluence / Jira / HubSpot / Dataverse\n`);
for (const r of rows) {
  const status = r.ops === 0 ? 'knowledge only' : `${r.bound}/${r.ops} ops bind`;
  console.log(`  ${r.name.slice(0, 40).padEnd(40)} [${[...r.targets].join('+')}]  ${status}${r.refused ? ` · ${r.refused} refused` : ''}`);
  const uniq = [...new Set(r.dropped)];
  if (uniq.length) console.log(`      dropped: ${uniq.slice(0, 4).join(', ')}${uniq.length > 4 ? ` +${uniq.length - 4}` : ''}`);
}

const per = new Map<string, { agents: number; ops: number; bound: number }>();
for (const r of rows) {
  for (const t of r.targets) {
    const e = per.get(t) ?? { agents: 0, ops: 0, bound: 0 };
    e.agents++;
    e.ops += r.ops;
    e.bound += r.bound;
    per.set(t, e);
  }
}
console.log('\n══ per connector');
for (const [t, e] of [...per.entries()].sort((a, b) => b[1].agents - a[1].agents)) {
  console.log(`  ${t.padEnd(12)} ${String(e.agents).padStart(2)} agent(s)   ${e.bound}/${e.ops} operations bind`);
}
process.exit(0);
