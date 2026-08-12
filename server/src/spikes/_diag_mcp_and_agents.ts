/**
 * What do MCP-server and connected-agent tools actually contain?
 *
 * The census counts 6 mcp-server and 2 connected-agent tools, and neither is built. Before
 * building anything, read what the payloads hold: an MCP tool we cannot get a URL for is
 * not buildable no matter how much deployer code exists, and a connected agent is only
 * wireable if we can identify WHICH agent it points at — and whether that agent is itself
 * in the migration.
 *
 * Read-only. Prints structure and ids, never credential values.
 *
 * npx tsx src/spikes/_diag_mcp_and_agents.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

interface Found { env: string; agent: string; kind: string; name: string; mcp?: unknown; raw?: string }
const found: Found[] = [];
const botNamesById = new Map<string, string>();

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch {
    continue;
  }
  for (const b of bots) botNamesById.set(b.botid.toLowerCase(), b.name);

  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    for (const t of ir.agentTools ?? []) {
      if (t.kind !== 'mcp-server' && t.kind !== 'connected-agent') continue;
      found.push({ env: env.name, agent: ir.name, kind: t.kind, name: t.name, mcp: t.mcp });
    }
  }
}

console.log(`\n══ ${found.length} MCP / connected-agent tool(s)\n`);
for (const f of found) {
  console.log(`  [${f.kind}] ${f.agent} → ${f.name.slice(0, 50)}`);
  if (f.mcp) console.log(`      mcp: ${JSON.stringify(f.mcp)}`);
}

// The decisive question for MCP: do we have a URL to call? And for connected agents: does
// the payload name a bot we could resolve — ideally one that is itself being migrated?
console.log(`\n══ what is missing to build each\n`);
const mcp = found.filter((f) => f.kind === 'mcp-server');
const withUrl = mcp.filter((f) => JSON.stringify(f.mcp ?? {}).match(/https?:\/\//));
console.log(`  mcp-server:      ${mcp.length} tool(s), ${withUrl.length} with a URL in the extracted binding`);
const ca = found.filter((f) => f.kind === 'connected-agent');
console.log(`  connected-agent: ${ca.length} tool(s)`);
for (const f of ca) {
  // The tool NAME is usually the target agent's display name; see whether it resolves to a
  // real bot in this tenant, which decides whether it can be wired to a migrated sibling.
  const target = [...botNamesById.values()].find(
    (n) => f.name.toLowerCase().includes(n.toLowerCase()) && n.length > 3,
  );
  console.log(`      "${f.name}" → ${target ? `resolves to agent "${target}"` : 'no matching agent found by name'}`);
}
process.exit(0);
