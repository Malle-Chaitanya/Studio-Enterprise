/**
 * Fix: remove googleSearch from the Confluence agent — for pure RAG from
 * agentFiles, no tool is needed. googleSearch may be causing the serve error.
 *
 * After running this, go to the agent in the Builder and click "Create" again
 * to re-deploy the updated config.
 *
 * Usage: cd server && npx tsx src/spikes/_fix_remove_search_tool.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_ID     = '8980160511526117673';
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentUrl = `${assistantBase}/agents/${AGENT_ID}`;

const agent = await getAgent(dest, saToken, AGENT_ID);
if (!agent) { console.error('getAgent failed'); process.exit(1); }
const files = readAgentFiles(agent);
const lcd = agent.lowCodeAgentDefinition as Record<string, unknown>;

const DISPLAY_NAME = agent.displayName as string;
const DESCRIPTION  = agent.description as string ?? '';

// Better instruction: don't say "search" — just use knowledge from files
const INSTRUCTION =
  'You are a helpful assistant for the CloudFuze team. ' +
  'Answer questions using the Confluence knowledge pages attached to this agent (Engineering, HR, Sales). ' +
  'Always cite the page title when referencing specific information. ' +
  'If the information is not available in your knowledge, say so clearly.';

const node = {
  id: 'root_agent',
  displayName: DISPLAY_NAME,
  llmAgentNode: {
    description: DESCRIPTION,
    model: 'gemini-2.5-flash',
    instruction: INSTRUCTION,
    subAgentIds: [],
    selectedTools: { tool: [] },  // No tools — pure knowledge from agentFiles
  },
};

console.log('PATCHing agent: removing googleSearch, updating instruction…');
const patchRes = await fetch(
  `${agentUrl}?updateMask=lowCodeAgentDefinition.nodes,lowCodeAgentDefinition.rootAgentId,lowCodeAgentDefinition.draftDisplayName,lowCodeAgentDefinition.draftDescription`,
  {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent',
        nodes: [node],
        draftDisplayName: DISPLAY_NAME,
        draftDescription: DESCRIPTION,
      },
    }),
  },
);
const patchText = await patchText2(patchRes);
console.log(`  PATCH status: ${patchRes.status}  ok=${patchRes.ok}`);
if (!patchRes.ok) console.error(`  Error: ${patchText.slice(0, 300)}`);

// Verify
const after = await getAgent(dest, saToken, AGENT_ID);
const afterLcd = after?.lowCodeAgentDefinition as Record<string, unknown> | undefined;
const nodes = (afterLcd?.nodes as Array<Record<string, unknown>>) ?? [];
const llm = (nodes[0]?.llmAgentNode as Record<string, unknown>);
console.log(`\nVerify:`);
console.log(`  nodes[0].model: ${llm?.model}`);
console.log(`  selectedTools: ${JSON.stringify(llm?.selectedTools)}`);
console.log(`  agentFiles: ${(afterLcd?.agentFiles as unknown[])?.length ?? 0}`);

console.log('\n✓ Done. Now in the Gemini Enterprise Agent Builder:');
console.log('  1. Open "Confluence Knowledge Agent (Test)"');
console.log('  2. Click "Create" to re-deploy the updated config');
console.log('  3. Test in Preview or the main chat');

async function patchText2(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ''; }
}
