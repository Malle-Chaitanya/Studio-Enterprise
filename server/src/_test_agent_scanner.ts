/**
 * Test agentFlowScanner against real Dataverse.
 * Run: npx tsx src/_test_agent_scanner.ts
 */
import { scanAgentFlows } from './services/agentFlowScanner.js';

const MS_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const MS_CLIENT = '68beff40-49fb-4e36-82fe-317bc839a344';
const DV_URL    = 'https://orga243378d.crm.dynamics.com';

async function getMsToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: MS_CLIENT, client_secret: process.env['MS_CLIENT_SECRET']!, scope: `${DV_URL}/.default` }) },
  );
  const j = await res.json() as { access_token?: string; error_description?: string };
  if (!j.access_token) throw new Error(j.error_description ?? 'token failed');
  return j.access_token;
}

async function main() {
  console.log('Getting MS token...');
  const token = await getMsToken();
  console.log('Token OK\n');

  console.log('Scanning Copilot Studio agent flows...');
  const result = await scanAgentFlows(DV_URL, token);

  console.log(`\n=== Agents (${result.agents.length}) ===`);
  for (const a of result.agents) {
    const flows = result.agentFlowMap[a.botId] ?? [];
    console.log(`  ${a.name}: ${flows.length} flows`);
  }

  console.log(`\n=== Flows (${result.flows.length} in agent solutions) ===`);
  for (const f of result.flows) {
    const directTag = f.directLink ? ' [DIRECT]' : ' [solution]';
    console.log(`  ${directTag} "${f.name}" state=${f.statecode}`);
  }

  console.log(`\n=== Agent→Flow Map ===`);
  for (const [botId, flowIds] of Object.entries(result.agentFlowMap)) {
    const agent = result.agents.find(a => a.botId === botId);
    console.log(`  ${agent?.name ?? botId}: ${flowIds.length} flows`);
    for (const fid of flowIds) {
      const flow = result.flows.find(f => f.workflowId === fid);
      console.log(`    - "${flow?.name ?? fid}"`);
    }
  }

  if (result.orphanFlows.length) {
    console.log(`\n=== Orphan Flows (no specific agent link): ${result.orphanFlows.length} ===`);
    for (const fid of result.orphanFlows) {
      const flow = result.flows.find(f => f.workflowId === fid);
      console.log(`  "${flow?.name ?? fid}"`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  ${result.agents.length} agents, ${result.flows.length} flows`);
  console.log(`  Direct links found: ${result.flows.some(f => f.directLink) ? 'YES' : 'NO (using solution fallback)'}`);
}

main().catch(console.error);
