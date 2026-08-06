/**
 * Dump and compare two agent definitions: working vs ours.
 * Usage: cd server && npx tsx src/spikes/_diag_compare_agents.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { getAgent } from '../services/geminiAgentFiles.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';

// ENABLED working agent vs our PRIVATE one
const WORKING_ID   = '11213382165064235953'; // CS_GE Knowledge Test Agent (ENABLED)
const OUR_ID       = '8980160511526117673';  // Confluence Knowledge Agent (Test) (PRIVATE)

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

for (const [label, id] of [['WORKING', WORKING_ID], ['OURS', OUR_ID]] as const) {
  const agent = await getAgent(dest, saToken, id);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label} agent: ${id}`);
  console.log('='.repeat(60));
  if (!agent) { console.log('  (null — GET failed)'); continue; }

  console.log(`displayName: ${agent.displayName}`);
  console.log(`state:       ${agent.state}`);

  const lcd = agent.lowCodeAgentDefinition as Record<string, unknown> | undefined;
  if (!lcd) { console.log('NO lowCodeAgentDefinition'); continue; }

  const files = (lcd.agentFiles as unknown[]) ?? [];
  console.log(`agentFiles:  ${files.length} files`);

  const nodes = (lcd.nodes as Array<Record<string, unknown>>) ?? [];
  console.log(`nodes (${nodes.length}):`);
  for (const n of nodes) {
    const llm = n.llmAgentNode as Record<string, unknown> | undefined;
    console.log(`  id=${n.id}  displayName="${n.displayName}"`);
    if (llm) {
      console.log(`    model=${llm.model}`);
      console.log(`    instruction(first 200): ${String(llm.instruction ?? '').slice(0, 200)}`);
      console.log(`    selectedTools: ${JSON.stringify(llm.selectedTools)}`);
    }
  }

  const deployedNodes = (lcd.deployedNodes as unknown[]) ?? [];
  console.log(`deployedNodes: ${deployedNodes.length}`);
  if (deployedNodes.length > 0) console.log(JSON.stringify(deployedNodes, null, 2).slice(0, 500));

  console.log(`rootAgentId: ${lcd.rootAgentId}`);
}
