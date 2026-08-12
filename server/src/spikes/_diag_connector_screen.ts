/**
 * What does the Connectors screen actually show for an agent whose tools are an MCP
 * server and connected agents?
 *
 * The screen is fed by detectKnowledgeConnectors, which is a REGEX SCAN over raw component
 * data, not the IR — so "the IR has the tool" says nothing about whether the customer is
 * asked for its credential. Ask the same function the route asks.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_connector_screen.ts "AA"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { detectKnowledgeConnectors } from '../services/knowledgeConnectorScan.js';

const needle = (process.argv[2] ?? '').toLowerCase();
await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch {
    continue;
  }
  const matched = bots.filter((b) => b.name.toLowerCase().includes(needle));
  if (!matched.length) continue;

  const names = new Map(matched.map((b) => [b.botid.toLowerCase(), b.name]));
  const detected = await detectKnowledgeConnectors(
    env.url,
    token,
    matched.map((b) => b.botid),
    names,
    { tenantId, environmentId: env.id },
  );

  console.log(`\n══ ${env.name} · ${matched.map((b) => b.name).join(', ')}`);
  if (!detected.length) console.log('  (the Connectors screen would show NOTHING for this agent)');
  for (const d of detected) {
    console.log(`\n  ${d.displayName ?? d.connectorId}  [${d.connectorId}]`);
    console.log(`    certain:    ${d.certain}   unsupported: ${d.unsupported ?? false}`);
    console.log(`    used by:    ${d.agentNames?.join(', ') ?? '?'}`);
    console.log(`    operations: ${d.operations?.length ? d.operations.join(', ') : '(none named)'}`);
  }
}
process.exit(0);
