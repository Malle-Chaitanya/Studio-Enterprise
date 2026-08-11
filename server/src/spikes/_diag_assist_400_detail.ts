/** Capture the raw error body from the :assist 400 that verify.ts swallows,
 * to confirm whether it's because the agent is DRAFT (unpublished) rather
 * than a grounding failure.
 *   npx tsx src/spikes/_diag_assist_400_detail.ts
 * READ-ONLY.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const GEMINI_PROJECT = '231705905417';
const GEMINI_ENGINE = 'gemini-enterprise-17847887_1784788734248';
const G_EMAIL = 'zara@storefuze.com';
const AGENT_ID = '3027457323471599777';

async function main() {
  const saToken = await getSaToken(G_EMAIL);
  const dest: GeminiDestination = { project: GEMINI_PROJECT, engine: GEMINI_ENGINE, assistant: 'default_assistant' };

  // First, GET the agent itself to check its publish/deploy state directly.
  const agentUrl = `${assistantBase(dest)}/agents/${AGENT_ID}`;
  const agentRes = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  const agentJson = await agentRes.json().catch(() => ({}));
  console.log('--- agent record ---');
  console.log('status:', agentRes.status);
  console.log(JSON.stringify(agentJson, null, 2).slice(0, 1500));

  console.log('\n--- :assist call raw error ---');
  const assistUrl = `${assistantBase(dest)}:assist`;
  const res = await fetch(assistUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: 'hello' }, agentId: AGENT_ID }),
  });
  const text = await res.text();
  console.log('status:', res.status);
  console.log('body:', text.slice(0, 1000));

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
