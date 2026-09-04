import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'global';
const ENGINE = 'gemini-enterprise-app_1787446545912';
const AGENT_ID = '2083305987611946841'; // currently configured in the Apps Script bridge

async function main() {
  const token = await getSaToken();
  const url = `https://${LOCATION}-discoveryengine.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE}/assistants/default_assistant:streamAssist?alt=sse`;
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
  const text = await res.text();
  console.log('Body (first 2000 chars):\n', text.slice(0, 2000));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
