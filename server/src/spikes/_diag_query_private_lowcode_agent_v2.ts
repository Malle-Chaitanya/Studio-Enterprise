// Retry with the correct assist shape (top-level "agent" full resource name,
// not "agentId" — see _diag_assist_shapes2.ts, which already proved this out).
//   npx tsx src/spikes/_diag_query_private_lowcode_agent_v2.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const AGENT_ID = '1354231029695078346'; // KB-Grounding-Test-Agent, Employee-made / Private
const agentResourceName = `projects/${DEST.project}/locations/global/collections/default_collection/engines/${DEST.engine}/assistants/${DEST.assistant}/agents/${AGENT_ID}`;

async function ask(saToken: string, message: string) {
  const res = await fetch(`${assistantBase(DEST)}:assist`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: message }, agent: agentResourceName }),
  });
  console.log(`\n>>> ${message}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'What is the "Slack to Teams Migration Guide" about? Summarize its key points and say which source you used.');
  await ask(saToken, 'What is the capital of France?');
}
main().catch((e) => console.error('FAILED:', e.message));
