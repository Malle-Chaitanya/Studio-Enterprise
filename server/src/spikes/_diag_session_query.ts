/**
 * Test agent via Session API (what business.gemini.google actually uses).
 * Also check file sizes and sample content.
 * Usage: cd server && npx tsx src/spikes/_diag_session_query.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_ID     = '8980160511526117673';
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';

const CONFLUENCE_BASE_URL = 'https://cf2020.atlassian.net';
const CONFLUENCE_EMAIL    = 'sujana.manapuram@cloudfuze.com';
const CONFLUENCE_TOKEN    = process.env.CONFLUENCE_TOKEN ?? '';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentUrl = `${assistantBase}/agents/${AGENT_ID}`;

// ── Check one Confluence page size ────────────────────────────────────────────
console.log('=== Sample Confluence page sizes ===');
const auth = 'Basic ' + Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_TOKEN}`).toString('base64');
const engPages = await fetch(
  `${CONFLUENCE_BASE_URL}/wiki/rest/api/space/ENG/content/page?limit=3&expand=body.view`,
  { headers: { Authorization: auth, Accept: 'application/json' } },
);
if (engPages.ok) {
  const data = await engPages.json() as { results?: Array<{ id: string; title: string; body?: { view?: { value?: string } } }> };
  for (const p of data.results ?? []) {
    const html = p.body?.view?.value ?? '';
    console.log(`  "${p.title}" — body.view size: ${html.length} chars, ${(html.length/1024).toFixed(1)}KB`);
  }
}

// ── Try creating a session and querying via Sessions API ──────────────────────
console.log('\n=== Creating session ===');
const sessionRes = await fetch(`${assistantBase}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agentId: AGENT_ID,
  }),
});
console.log(`createSession: ${sessionRes.status}`);
const sessionText = await sessionRes.text();
console.log(sessionText.slice(0, 300));

// ── Try streamAnswer ──────────────────────────────────────────────────────────
console.log('\n=== Trying streamAnswer API ===');
const streamRes = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/sessions/-:streamAnswer`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: AGENT_ID,
      query: { text: 'What is on the Engineering home page?' },
    }),
  },
);
console.log(`streamAnswer: ${streamRes.status}`);
const streamText = await streamRes.text();
console.log(streamText.slice(0, 800));

// ── Try the agent's own sessions (sessions scoped to agent) ───────────────────
console.log('\n=== Agent-scoped session ===');
const aSessionRes = await fetch(`${agentUrl}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
console.log(`agent createSession: ${aSessionRes.status}`);
const aSessionText = await aSessionRes.text();
let sessionId = '';
try {
  const j = JSON.parse(aSessionText) as { name?: string };
  sessionId = j.name?.split('/').pop() ?? '';
} catch { /* ignore */ }
console.log(aSessionText.slice(0, 300));

if (sessionId) {
  console.log(`\n=== Querying agent-scoped session ${sessionId} ===`);
  const qRes = await fetch(`${agentUrl}/sessions/${sessionId}:streamAnswer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { text: 'What is on the Engineering home page?' },
    }),
  });
  console.log(`streamAnswer (agent session): ${qRes.status}`);
  const qText = await qRes.text();
  console.log(qText.slice(0, 800));
}
