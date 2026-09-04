/**
 * What does extraction actually capture for the Meeting Intelligence agent's
 * Outlook, Calendar, and HubSpot MCP tools specifically?
 *
 * Targeted version of _diag_mcp_and_agents.ts — only extracts the one agent
 * whose name matches, instead of churning through the whole tenant.
 *
 * Read-only. Prints structure and ids, never credential values.
 *
 * npx tsx src/spikes/_diag_meeting_intelligence_mcp.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';

const NAME_MATCH = /meeting.?intelligence/i;

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true, $ne: '' } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

let found = false;
for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch (err) {
    console.log(`  [skip env ${env.name}] ${(err as Error).message}`);
    continue;
  }

  const match = bots.find((b) => NAME_MATCH.test(b.name));
  if (!match) continue;
  found = true;

  console.log(`\n══ Found "${match.name}" in environment "${env.name}" (${env.url})\n`);
  const ir = await extractAgent(env.url, token, match).catch((err) => {
    console.log(`  extraction FAILED: ${(err as Error).message}`);
    return null;
  });
  if (!ir) continue;

  console.log(`Agent: ${ir.displayName ?? ir.name}`);
  console.log(`Total agentTools: ${ir.agentTools?.length ?? 0}\n`);

  for (const t of ir.agentTools ?? []) {
    console.log(`── Tool: ${t.name}`);
    console.log(`   kind: ${t.kind}`);
    console.log(`   displayName: ${t.displayName ?? '(none)'}`);
    console.log(`   description: ${(t.description ?? '(none)').slice(0, 120)}`);
    console.log(`   connectorId: ${t.connectorId ?? '(none)'}`);
    console.log(`   connectionAuthMode: ${t.connectionAuthMode ?? '(unspecified)'}`);
    console.log(`   operationId: ${t.operationId ?? '(none)'}`);
    if (t.kind === 'mcp-server') {
      console.log(`   mcp.operationId: ${t.mcp?.operationId ?? '(none)'}`);
      console.log(`   mcp.toolSelection: ${t.mcp?.toolSelection ?? '(none)'}`);
      console.log(`   mcp.tools: ${JSON.stringify(t.mcp?.tools ?? [])}`);
      console.log(`   mcp.serverUrl: ${t.mcp?.serverUrl ?? '(none)'}`);
    }
    console.log('');
  }
}

if (!found) {
  console.log('\nNo agent matching "Meeting Intelligence" found across any environment in this tenant.');
  console.log('Check the exact display name in Copilot Studio and adjust NAME_MATCH if needed.');
}
process.exit(0);
