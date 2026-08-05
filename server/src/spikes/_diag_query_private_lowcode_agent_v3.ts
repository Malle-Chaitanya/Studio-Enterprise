// Try the path-scoped assist endpoint (Shape E from _diag_assist_shapes2.ts):
// assistants/{assistant}/agents/{id}:assist — instead of a body field.
//   npx tsx src/spikes/_diag_query_private_lowcode_agent_v3.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const AGENT_ID = '1354231029695078346';

async function ask(saToken: string, message: string) {
  const url = `${assistantBase(DEST)}/agents/${AGENT_ID}:assist`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: message } }),
  });
  console.log(`\n>>> ${message}`);
  console.log('url:', url);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'What is the "Slack to Teams Migration Guide" about? Summarize its key points and say which source you used.');
}
main().catch((e) => console.error('FAILED:', e.message));
