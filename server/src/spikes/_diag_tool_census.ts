/**
 * For EVERY agent in EVERY environment: what tools does it have, and how many of them
 * produce a real call?
 *
 * "Can we find the tools on any agent?" is only answerable agent-by-agent across the whole
 * tenant — the Hubspot agent looked fine until it was measured. Two numbers per agent:
 * FOUND (tools the extractor sees) and CALLABLE (tools that bind to a vendor URL). A gap
 * between them is a capability the migrated agent will not have, and it must be nameable.
 *
 * Read-only. Prints names and operation ids, never credential values.
 *
 * npx tsx src/spikes/_diag_tool_census.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

const byKind = new Map<string, number>();
const unreadable: string[] = [];
let agentsWithTools = 0;
let agentsFullyCallable = 0;
let toolsFound = 0;
let callsBuilt = 0;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch (err) {
    unreadable.push(`${env.name} — ${(err as Error).message.slice(0, 90)}`);
    continue;
  }

  console.log(`\n${'='.repeat(78)}\n  ${env.name}  (${bots.length} agents)\n${'='.repeat(78)}`);
  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    const tools = ir.agentTools ?? [];
    if (!tools.length) continue;
    agentsWithTools++;
    toolsFound += tools.length;
    for (const t of tools) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);

    // The same builder the migration uses, against the customer's own definitions.
    const build = await buildBoundToolSpecs(ir, { tenantId, environmentId: env.id }, {});
    const specs = [...build.byConnector.values()].flat();
    callsBuilt += specs.length;

    // An MCP server counts once as a tool but yields many calls, so "specs >= tools" is
    // the honest test for "nothing was dropped", not equality.
    const complete = specs.length >= tools.length;
    if (complete) agentsFullyCallable++;
    console.log(
      `\n  ${complete ? 'OK  ' : 'GAP '} ${ir.name.slice(0, 46).padEnd(46)} ` +
        `${tools.length} tool(s) → ${specs.length} call(s)`,
    );
    const kinds = [...new Set(tools.map((t) => t.kind))].join(', ');
    console.log(`        kinds: ${kinds}`);
    if (!complete) {
      const built = new Set(specs.map((s) => `${s.connectorId}.${s.operationId}`));
      const missing = tools.filter((t) => {
        if (!t.connectorId) return true;
        // An MCP server's own operationId names the SERVER and is never a spec key; it is
        // satisfied when the tools it DECLARED bound. Keying on the server id listed a
        // fully-rebuilt Jira MCP server as "no call".
        if (t.kind === 'mcp-server') return !(t.mcp?.tools ?? []).some((op) => built.has(`${t.connectorId}.${op}`));
        return !t.operationId || !built.has(`${t.connectorId}.${t.operationId}`);
      });
      for (const m of missing.slice(0, 8)) {
        console.log(`        no call: ${m.name.slice(0, 40)}  [${m.kind}] ${m.connectorId ?? '(no connector)'}${m.operationId ? `.${m.operationId}` : ''}`);
      }
      if (missing.length > 8) console.log(`        … ${missing.length - 8} more`);
    }
  }
}

console.log(`\n${'─'.repeat(78)}`);
console.log(`${agentsWithTools} agent(s) with tools · ${agentsFullyCallable} fully callable`);
console.log(`${toolsFound} tool(s) found → ${callsBuilt} vendor call(s) built`);
console.log(`by kind: ${[...byKind].map(([k, n]) => `${k}=${n}`).join('  ')}`);
if (unreadable.length) {
  console.log(`\nCOULD NOT READ ${unreadable.length} environment(s) — agents there are absent from every number above:`);
  for (const u of unreadable) console.log(`  ${u}`);
}
process.exit(0);
