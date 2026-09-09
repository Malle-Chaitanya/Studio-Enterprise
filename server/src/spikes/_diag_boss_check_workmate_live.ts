import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'global';
const ENGINE = 'gemini-enterprise-app_1787446545912';
const AGENT_ID = '4163375760872779420'; // WorkMate, last confirmed verified 2026-08-23 09:55

async function main() {
  const token = await getSaToken();
  const url = `https://${LOCATION}-discoveryengine.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE}/assistants/default_assistant:streamAssist?alt=sse`;
  console.log('Calling:', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: null,
      query: { text: 'List the companies you have access to in HubSpot.' },
      agentsSpec: { agentSpecs: [{ agentId: AGENT_ID }] },
    }),
  });
  console.log('HTTP status:', res.status);

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let collected = '';
  const deadline = Date.now() + 70000;
  if (reader) {
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        collected += decoder.decode(value, { stream: true });
        if (collected.includes('"state": "SUCCEEDED"') || collected.includes('"state":"SUCCEEDED"')) break;
      }
    } catch (e) {
      console.log('Stream read ended:', (e as Error).message);
    }
  }
  console.log('Collected so far (first 4000 chars):\n', collected.slice(0, 4000));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
