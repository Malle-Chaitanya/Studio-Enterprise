import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';
import type { GeminiDestination } from '../types.js';

const dest: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const AGENT_ID = '10175339144811279956'; // Sales Opportunity Agent

async function main() {
  const saToken = await getSaToken();
  const agent = await getAgent(dest, saToken, AGENT_ID);
  const files = readAgentFiles(agent);
  console.log(`Sales Opportunity Agent — ${files.length} file(s) attached:`);
  for (const f of files) console.log(` - ${f.fileName}`);
  if (!files.length) console.log('(raw agent dump for inspection:)', JSON.stringify(agent, null, 2).slice(0, 2000));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
