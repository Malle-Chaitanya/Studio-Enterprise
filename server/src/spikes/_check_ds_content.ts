/**
 * Check what content is in the data store and what the agent API looks like.
 * Run: cd server && npx tsx src/spikes/_check_ds_content.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';
const DATA_STORE_ID = 'confluence-knowledge-agent-all';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const agentBase = `${collBase}/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

// ── 1. List documents in the data store ──────────────────────────────────────
console.log('═══ 1. Documents in data store ═══');
const listUrl = `${collBase}/dataStores/${DATA_STORE_ID}/branches/default_branch/documents?pageSize=10`;
const listR = await fetch(listUrl, { headers: { Authorization: `Bearer ${saToken}` } });
const listJ = await listR.json() as {
  documents?: Array<{ name: string; id?: string; content?: { mimeType?: string; uri?: string }; structData?: Record<string, unknown> }>;
  totalSize?: number;
};
console.log(`Status: ${listR.status}`);
console.log(`Total docs: ${listJ.totalSize ?? (listJ.documents?.length ?? 0)}`);
for (const d of listJ.documents ?? []) {
  console.log(`  id=${d.id ?? d.name.split('/').pop()} mimeType=${d.content?.mimeType ?? '?'} uri=${d.content?.uri ?? '?'}`);
}

// ── 2. Raw search result to see full structure ────────────────────────────────
console.log('\n═══ 2. Raw search result ═══');
const searchUrl = `${collBase}/dataStores/${DATA_STORE_ID}/servingConfigs/default_config:search`;
const sR = await fetch(searchUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'sick leave policy', pageSize: 3 }),
});
const sJ = await sR.json() as { results?: unknown[]; summary?: unknown };
console.log(`Status: ${sR.status}`);
console.log(JSON.stringify(sJ, null, 2).slice(0, 1500));

// ── 3. Check all data stores — which ones have docs? ─────────────────────────
console.log('\n═══ 3. Check all data stores for content ═══');
const allDsR = await fetch(`${collBase}/dataStores`, { headers: { Authorization: `Bearer ${saToken}` } });
const allDsJ = await allDsR.json() as { dataStores?: Array<{ name: string }> };
for (const ds of allDsJ.dataStores ?? []) {
  const id = ds.name.split('/').pop()!;
  if (id.startsWith('agentspace-hybrid')) {
    console.log(`  ${id} — (hybrid, managed by Agentspace, skip)`);
    continue;
  }
  const docR = await fetch(`${collBase}/dataStores/${id}/branches/default_branch/documents?pageSize=1`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const docJ = await docR.json() as { documents?: unknown[]; totalSize?: number };
  const count = docJ.totalSize ?? docJ.documents?.length ?? 0;
  console.log(`  ${id} — ${docR.status === 200 ? count + ' doc(s)' : 'error ' + docR.status}`);
}

// ── 4. Check what API the agents expose ──────────────────────────────────────
console.log('\n═══ 4. Agent APIs (OPTIONS / GET) ═══');
const AGENT_ID = '11632552002298015870';
// Try different known Discovery Engine agent APIs
const endpoints = [
  `${agentBase}/${AGENT_ID}`,
  `${agentBase}/${AGENT_ID}/sessions`,
  `${agentBase}/${AGENT_ID}/conversations`,
];
for (const ep of endpoints) {
  const r = await fetch(ep, { headers: { Authorization: `Bearer ${saToken}` } });
  const body = await r.text();
  console.log(`  GET ${ep.split('/agents/')[1]}: ${r.status} — ${body.slice(0, 80)}`);
}
