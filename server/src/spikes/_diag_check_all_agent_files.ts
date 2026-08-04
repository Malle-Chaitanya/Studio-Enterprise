import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';
import type { GeminiDestination } from '../types.js';

const dest: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

const AGENTS: [string, string][] = [
  ['Sales Opportunity Agent (Private/low-code)', '10175339144811279956'],
  ['Sales Qualification Agent Config Assistant (Private/low-code)', '17373289897484752578'],
  ['Service Operations Agent (Private/low-code)', '10150097381590277974'],
  ['D365 Sales - Data Enrichment (Private/low-code)', '2556380900043818787'],
  ['ADK Website Live Test 2 (Enabled/ADK)', '3979879510128523003'],
  ['Service Operations Agent (Enabled/ADK)', '17210952303863824105'],
  ['Manual Test Agent (Enabled/ADK)', '9051481865327859287'],
];

async function main() {
  const saToken = await getSaToken();
  for (const [label, id] of AGENTS) {
    try {
      const agent = await getAgent(dest, saToken, id) as Record<string, unknown>;
      const files = readAgentFiles(agent);
      const defType = agent.lowCodeAgentDefinition ? 'lowCodeAgentDefinition' : agent.adkAgentDefinition ? 'adkAgentDefinition' : 'unknown';
      console.log(`${label}\n  defType: ${defType}  |  agentFiles: ${files.length}${files.length ? ' -> ' + files.map(f=>f.fileName).join(', ') : ''}\n`);
    } catch (e) {
      console.log(`${label}\n  ERROR: ${(e as Error).message}\n`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
