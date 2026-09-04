import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { writeFileSync } from 'fs';

const PROJECT = 'agentmigrations';
const LOCATION = 'global';
const ENGINE = 'gemini-enterprise-app_1787446545912';
const AGENT_ID = '10776999723910816732';

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
  const text = await res.text();
  writeFileSync('C:/Users/CHAITA~1/AppData/Local/Temp/claude/C--Users-ChaitanyaMalle-Studio-Enterprise-Studio-Enterprise/33f35a95-8f9f-4dcf-ab87-9f2d26f4aa42/scratchpad/full_capture.json', text);
  console.log('Saved', text.length, 'chars');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
