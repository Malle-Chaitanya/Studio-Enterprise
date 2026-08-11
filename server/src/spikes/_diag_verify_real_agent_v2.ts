/** Retry with the correct request shape found in
 * _diag_query_private_lowcode_agent_v3.ts: agent id belongs in the URL PATH
 * (assistants/{a}/agents/{id}:assist), not as a body field — verify.ts's
 * `agentId` body field is what caused the 400.
 *   npx tsx src/spikes/_diag_verify_real_agent_v2.ts
 * READ-ONLY.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const AGENT_ID = '3027457323471599777';

async function ask(saToken: string, message: string) {
  const url = `${assistantBase(DEST)}/agents/${AGENT_ID}:assist`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: message } }),
  });
  console.log(`\n>>> ${message}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  const saToken = await getSaToken('zara@storefuze.com');
  await ask(saToken, 'According to your FAQ knowledge, what destinations does CloudFuze support migrating TO? Quote the specific platforms mentioned.');
  await ask(saToken, 'What files or documents do you have access to as knowledge sources? List their names.');
}
main().catch((e) => console.error('FAILED:', e.message));
