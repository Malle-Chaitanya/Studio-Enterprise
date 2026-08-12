/**
 * Read-only check of Agent1's current registration before deciding whether to
 * redeploy it with the new Erik_googleDrive data store attached. Prints
 * displayName/description/reasoningEngine/state — does NOT modify anything.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const AGENT_ID = '14212399438010454597';
const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`${assistantBase(DEST)}/agents/${AGENT_ID}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`FAILED ${res.status}: ${text.slice(0, 500)}`);
    return;
  }
  console.log(JSON.stringify(JSON.parse(text), null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
