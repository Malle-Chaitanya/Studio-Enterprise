/**
 * Every top-level `kind:` on a componenttype-9 row across the tenant, and whether we parse it.
 *
 * Extraction recognises two shapes: `Invoke*TaskAction` (TaskDialog tools) and
 * `InvokeConnectorAction` (actions inside an AdaptiveDialog topic). A row whose kind is
 * neither yields no tool and no note — invisible, not refused. "Hubspot agentt" is four
 * HubSpot calls that vanish this way. Count how many more there are before fixing one.
 *
 * Read-only. Prints kinds and counts, never payload text.
 *
 * npx tsx src/spikes/_diag_component_kinds.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';

/**
 * Whether a kind is parsed is NOT decidable by a regex over the kind string — a TaskDialog
 * row is parsed through its NESTED `Invoke*TaskAction`, so testing the top-level kind
 * against a pattern I invented reported 69 correctly-parsed rows as lost. Ask extraction
 * instead: for each kind, show the agents that have it alongside what extractAgent
 * actually produced for them.
 */

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

const kindCount = new Map<string, number>();
const kindAgents = new Map<string, Set<string>>();
const connectorToolOps = new Map<string, number>();
/** Enough to re-extract an agent later without a second listBots pass. */
const agentIndex = new Map<string, { envUrl: string; token: string; bot: Awaited<ReturnType<typeof listBots>>[number]; kinds: Map<string, number> }>();

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch {
    console.log(`(skipping ${env.name} — cannot read)`);
    continue;
  }
  console.log(`${env.name}: scanning ${bots.length} agent(s)…`);

  for (const bot of bots) {
    const res = await fetch(
      `${env.url}/api/data/v9.2/botcomponents?$filter=_parentbotid_value eq ${bot.botid} and componenttype eq 9` +
        `&$select=name,data,content`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) continue;
    const comps = ((await res.json()) as { value?: Array<{ data?: string; content?: string }> }).value ?? [];
    const localKinds = new Map<string, number>();
    for (const c of comps) {
      const payload = c.data || c.content || '';
      // The FIRST kind line is the row's own kind; nested ones are its steps.
      const kind = /^\s*kind:\s*(\w+)\s*$/m.exec(payload)?.[1];
      if (!kind) continue;
      kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
      localKinds.set(kind, (localKinds.get(kind) ?? 0) + 1);
      if (!kindAgents.has(kind)) kindAgents.set(kind, new Set());
      kindAgents.get(kind)!.add(bot.name);
      if (kind === 'ConnectorTool') {
        const op = /^\s*operationId:\s*(\S+)\s*$/m.exec(payload)?.[1] ?? '(none)';
        connectorToolOps.set(op, (connectorToolOps.get(op) ?? 0) + 1);
      }
    }
    agentIndex.set(bot.name, { envUrl: env.url, token, bot, kinds: localKinds });
  }
}

console.log(`\n══ componenttype-9 kinds across the tenant\n`);
for (const [kind, n] of [...kindCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(28)} ${String(n).padStart(4)} row(s)  ${kindAgents.get(kind)!.size} agent(s)`);
}

// The decisive check. For each rare kind, re-extract the agents that have it and print
// what extraction produced. A kind is only lost if the tools it should have made are
// absent — the previous version of this spike guessed from the kind STRING and reported
// 69 correctly-parsed TaskDialog rows as lost.
console.log(`\n══ what does extraction actually produce for the rare kinds?\n`);
for (const [kind, total] of kindCount) {
  if (total > 20) continue; // AdaptiveDialog/TaskDialog are the bulk; proven by the census
  console.log(`  ${kind}:`);
  for (const agentName of kindAgents.get(kind) ?? []) {
    const rec = agentIndex.get(agentName);
    if (!rec) continue;
    const ir = await extractAgent(rec.envUrl, rec.token, rec.bot).catch(() => null);
    if (!ir) {
      console.log(`    ${agentName}: extraction failed`);
      continue;
    }
    const tools = (ir.agentTools ?? []).map((t) => `${t.kind}:${t.operationId ?? t.name.slice(0, 20)}`);
    console.log(
      `    ${agentName.slice(0, 32).padEnd(32)} ${rec.kinds.get(kind) ?? 0} row(s) of this kind → ${tools.length} tool(s) total`,
    );
    console.log(`        extracted: ${tools.join(', ') || '(NONE)'}`);
  }
}

if (connectorToolOps.size) {
  console.log(`\n══ operations lost to the unparsed ConnectorTool shape\n`);
  for (const [op, n] of [...connectorToolOps.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}x ${op}`);
  }
  console.log(`\n  agents affected: ${[...(kindAgents.get('ConnectorTool') ?? [])].join(', ')}`);
}
process.exit(0);
