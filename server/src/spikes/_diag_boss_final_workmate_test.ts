import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { writeFileSync } from 'fs';

const PROJECT = 'agentmigrations';
const LOCATION = 'global';
const ENGINE = 'gemini-enterprise-app_1787446545912';
const AGENT_ID = '11078644586713090223'; // WorkMate, confirmed working live in the console

async function testQuery(label: string, text: string) {
  const token = await getSaToken();
  const url = `https://${LOCATION}-discoveryengine.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE}/assistants/default_assistant:streamAssist?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: null,
      query: { text },
      agentsSpec: { agentSpecs: [{ agentId: AGENT_ID }] },
    }),
  });

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const deadline = Date.now() + 70000;
  if (reader) {
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        if (raw.includes('"state": "SUCCEEDED"')) break;
      }
    } catch (e) {
      console.log(`  (stream ended: ${(e as Error).message})`);
    }
  }

  const hasToolCall = /functionCall|functionResponse/.test(raw);
  const identifiesAsGemini = /I am Gemini Enterprise/i.test(raw);
  writeFileSync(`C:/Users/CHAITA~1/AppData/Local/Temp/claude/C--Users-ChaitanyaMalle-Studio-Enterprise-Studio-Enterprise/33f35a95-8f9f-4dcf-ab87-9f2d26f4aa42/scratchpad/final_${label}.json`, raw);
  console.log(`\n[${label}] "${text}"`);
  console.log(`  HTTP status: ${res.status}`);
  console.log(`  Bytes collected: ${raw.length}`);
  console.log(`  Real tool call frames present: ${hasToolCall}`);
  console.log(`  Identifies as "Gemini Enterprise" (Core Assistant fallback): ${identifiesAsGemini}`);
}

async function main() {
  await testQuery('hubspot', 'List all the companies in HubSpot');
  await testQuery('drive', 'List the files in my Google Drive root folder');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
