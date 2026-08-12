/**
 * The four connectors we are committing to first: Confluence, Jira, SharePoint, HubSpot.
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
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';

/** Match on the connector id AND on the operation shape, because the extraction bug
 *  (topic-embedded actions) loses the connector id and leaves only the operation name. */
const TARGETS: Record<string, RegExp> = {
  Confluence: /confluence/i,
  Jira: /jira/i,
  SharePoint: /sharepoint/i,
  // A CUSTOM HubSpot connector is named after its display name, so the id is
  // `shared_get-20crm-20objects-20from-20hubspot-…`. Matching the substring catches both
  // the first-party connectors and the customer's own.
  HubSpot: /hubspot/i,
};

function targetOf(connectorId: string | undefined, operationId: string | undefined): string | null {
  for (const [name, re] of Object.entries(TARGETS)) {
    if ((connectorId && re.test(connectorId)) || (operationId && re.test(operationId))) return name;
  }
  return null;
}

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;
// Every environment, not the two that happened to be hard-coded — a target connector used
// by an agent in an environment we skipped is a gap we would report as "none found".
const envs = await discoverEnvironments(tenantId);
const unreadable: string[] = [];

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
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch (err) {
    unreadable.push(`${env.name} — ${(err as Error).message.slice(0, 70)}`);
    continue;
  }
  for (const bot of bots) {
    let ir;
    try {
      ir = await extractAgent(env.url, token, bot);
    } catch {
      continue;
    }
    // MCP servers count: a Jira MCP server IS Jira usage, and its declared tools rebuild
    // as ordinary connector operations (ledger 1.24). Excluding them undercounted Jira.
    const tools = (ir.agentTools ?? []).filter((t) => t.kind === 'connector' || t.kind === 'mcp-server');
    const relevant = tools.filter((t) => targetOf(t.connectorId, t.operationId));
    // Confluence also arrives as a KNOWLEDGE source, not a tool — an agent grounded on
    // Confluence spaces has no connector tool at all and would be invisible here.
    const cfKnowledge = (ir.knowledgeSources ?? []).filter(
      (k) => Array.isArray(k.confluenceSpaceNames) && k.confluenceSpaceNames.length > 0,
    );
    // SharePoint is overwhelmingly a KNOWLEDGE source, not a tool: an agent grounded on a
    // SharePoint site has no connector tool at all. Counting only tools reported SharePoint
    // as one agent, which is the opposite of the truth.
    const spKnowledge = (ir.knowledgeSources ?? []).filter(
      (k) => /sharepoint/i.test(k.kind ?? '') || /sharepoint\.com/i.test(JSON.stringify(k).slice(0, 4000)),
    );
    if (!relevant.length && !cfKnowledge.length && !spKnowledge.length) continue;

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
    if (spKnowledge.length) targets.add('SharePoint');

    rows.push({
      env: env.name,
      name: ir.name,
      targets,
      ops: relevant.length,
      bound: relevant.filter((t) =>
        t.kind === 'mcp-server'
          ? (t.mcp?.tools ?? []).some((op) => boundIds.has(op))
          : !!t.operationId && boundIds.has(t.operationId),
      ).length,
      refused: (build?.notes ?? []).filter((n) => n.status === 'lost').length,
      dropped: relevant
        .filter((t) =>
          t.kind === 'mcp-server'
            ? !(t.mcp?.tools ?? []).some((op) => boundIds.has(op))
            : !!t.operationId && !boundIds.has(t.operationId),
        )
        .map((t) => `${t.connectorId ?? '(no id)'}:${t.operationId}`),
    });
  }
}

rows.sort((a, b) => b.bound - a.bound || b.ops - a.ops);
console.log(`\n══ ${rows.length} agent(s) using Confluence / Jira / SharePoint / HubSpot\n`);
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
if (unreadable.length) {
  console.log(`
NOT SEARCHED - ${unreadable.length} environment(s); a target agent there is absent above:`);
  for (const u of unreadable) console.log(`  ${u}`);
}
process.exit(0);
