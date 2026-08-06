/**
 * Try engine :converse endpoint + check agentspace-hybrid data store solution types.
 * Run: cd server && npx tsx src/spikes/_test_agent_answer4.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const DS_ID = 'confluence-knowledge-agent-all';
const AGENT_ID = '11632552002298015870';
const QUESTION = 'What is the sick leave policy?';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);

const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${dest.engine}`;

console.log(`Engine: ${dest.engine}\n`);

// ── 1. Engine servingConfig :converse ─────────────────────────────────────────
console.log('═══ 1. Engine :converse endpoint ═══');
const convR = await fetch(`${engineBase}/servingConfigs/default_config:converse`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: { input: QUESTION },
  }),
});
const convT = await convR.text();
console.log(`Status: ${convR.status}`);
if (convR.ok) {
  const j = JSON.parse(convT) as Record<string, unknown>;
  console.log(`\n✅ CONVERSE RESPONSE:\n${JSON.stringify(j, null, 2).slice(0, 600)}`);
} else {
  console.log(`Error: ${convT.slice(0, 400)}`);
}

// ── 2. Engine :converse with agent hint ────────────────────────────────────────
console.log('\n═══ 2. Engine :converse with agent id in body ═══');
const conv2R = await fetch(`${engineBase}/servingConfigs/default_config:converse`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: { input: QUESTION },
    requestId: AGENT_ID,
    safeSearch: false,
  }),
});
const conv2T = await conv2R.text();
console.log(`Status: ${conv2R.status} — ${conv2T.slice(0, 200)}`);

// ── 3. Check agentspace-hybrid data store solution types ──────────────────────
console.log('\n═══ 3. agentspace-hybrid data store details ═══');
const allDsR = await fetch(`${collBase}/dataStores`, { headers: { Authorization: `Bearer ${saToken}` } });
const allDsJ = await allDsR.json() as { dataStores?: Array<{ name: string; solutionTypes?: string[]; contentConfig?: string; industryVertical?: string }> };
for (const ds of allDsJ.dataStores ?? []) {
  console.log(`  ${ds.name.split('/').pop()}`);
  console.log(`    solutionTypes   : ${(ds.solutionTypes ?? []).join(', ')}`);
  console.log(`    contentConfig   : ${ds.contentConfig ?? '?'}`);
  console.log(`    industryVertical: ${ds.industryVertical ?? '?'}`);
}

// ── 4. Our confluence data store details ──────────────────────────────────────
console.log('\n═══ 4. Our confluence data store full details ═══');
const dsR = await fetch(`${collBase}/dataStores/${DS_ID}`, { headers: { Authorization: `Bearer ${saToken}` } });
const dsT = await dsR.text();
console.log(`Status: ${dsR.status}`);
if (dsR.ok) {
  const j = JSON.parse(dsT) as Record<string, unknown>;
  console.log(JSON.stringify(j, null, 2).slice(0, 800));
} else {
  console.log(`Error: ${dsT.slice(0, 200)}`);
}

// ── 5. Try Vertex AI Conversation API (different API surface) ─────────────────
console.log('\n═══ 5. Vertex AI Conversation API ═══');
const vertexConvR = await fetch(
  `https://discoveryengine.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/collections/default_collection/engines/${dest.engine}/servingConfigs/default_config:converse`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { input: QUESTION } }),
  },
);
const vertexConvT = await vertexConvR.text();
console.log(`Status: ${vertexConvR.status}`);
console.log(`Response: ${vertexConvT.slice(0, 400)}`);

// ── 6. Try agentspace.googleapis.com (separate Agentspace API) ────────────────
console.log('\n═══ 6. agentspace.googleapis.com ═══');
const agentspaceR = await fetch(
  `https://agentspace.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/collections/default_collection/engines/${dest.engine}/sessions`,
  {
    headers: { Authorization: `Bearer ${saToken}` },
  },
);
const agentspaceT = await agentspaceR.text();
console.log(`Status: ${agentspaceR.status} — ${agentspaceT.slice(0, 200)}`);

// ── 7. Check if engine has any servingConfigs ─────────────────────────────────
console.log('\n═══ 7. List engine serving configs ═══');
const scR = await fetch(`${engineBase}/servingConfigs`, { headers: { Authorization: `Bearer ${saToken}` } });
const scT = await scR.text();
console.log(`Status: ${scR.status}`);
if (scR.ok) {
  const j = JSON.parse(scT) as { servingConfigs?: Array<{ name: string; solutionType?: string }> };
  for (const sc of j.servingConfigs ?? []) {
    console.log(`  ${sc.name.split('/').pop()} (${sc.solutionType ?? '?'})`);
  }
} else {
  console.log(`Error: ${scT.slice(0, 200)}`);
}

// ── 8. Try session create with turnCount field ────────────────────────────────
console.log('\n═══ 8. Session create with turnCount ═══');
const newSessR = await fetch(`${engineBase}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ userPseudoId: 'testuser', turns: [] }),
});
const newSessT = await newSessR.text();
console.log(`Status: ${newSessR.status}`);
if (newSessR.ok) {
  const j = JSON.parse(newSessT) as { name: string };
  const sessId = j.name.split('/').pop()!;
  console.log(`Session created: ${sessId}`);
  // Try to get answer for this session
  const ansR = await fetch(`${engineBase}/sessions/${sessId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { text: QUESTION, queryId: 'q1' },
    }),
  });
  const ansT = await ansR.text();
  console.log(`answers endpoint: ${ansR.status} — ${ansT.slice(0, 200)}`);
  // Try PATCH to add a turn
  const patchR = await fetch(`${engineBase}/sessions/${sessId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      turns: [{ query: { text: QUESTION, queryId: 'q1' } }],
      userPseudoId: 'testuser',
    }),
  });
  const patchT = await patchR.text();
  console.log(`PATCH session: ${patchR.status} — ${patchT.slice(0, 200)}`);
} else {
  console.log(`Error: ${newSessT.slice(0, 200)}`);
}
