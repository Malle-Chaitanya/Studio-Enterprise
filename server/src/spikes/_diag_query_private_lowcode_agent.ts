// Queries a PRIVATE (not gallery-visible) low-code agent directly via the
// Discovery Engine assistant ":assist" endpoint — the same mechanism
// verify.ts uses. "Private" gates the gallery/chat UI, not API access.
//   npx tsx src/spikes/_diag_query_private_lowcode_agent.ts
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

async function ask(saToken: string, message: string) {
  const res = await fetch(`${assistantBase(DEST)}:assist`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: message }, agentId: AGENT_ID }),
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
