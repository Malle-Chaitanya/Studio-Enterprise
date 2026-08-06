/**
 * List all agents in mia's Gemini project + delete old/broken ones.
 * Usage: cd server && npx tsx src/spikes/_diag_list_agents.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';

// New RE (v3, just deployed)
const NEW_RE = 'projects/231705905417/locations/us-central1/reasoningEngines/8180209830246481920';

const tok  = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, tok);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

// ── List all agents ───────────────────────────────────────────────────────────
const r = await fetch(`${base}/agents?pageSize=50`, { headers: { Authorization: `Bearer ${tok}` } });
const j = await r.json() as { agents?: Array<Record<string, unknown>> };
const agents = j.agents ?? [];
console.log(`Total agents: ${agents.length}`);
for (const a of agents) {
  const id = (a['name'] as string).split('/').pop();
  console.log(`  ${id}  "${a['displayName']}"  ${a['state']}  ${String(a['createTime']).slice(0, 10)}`);
}

// ── Delete all agents EXCEPT keep a slot for our new one ──────────────────────
// Quota is likely "max N agents" — delete all old/broken agents
const toKeep = new Set<string>();  // keep none — we're re-registering fresh
const toDelete = agents.filter(a => {
  const id = (a['name'] as string).split('/').pop()!;
  return !toKeep.has(id);
});
console.log(`\nDeleting ${toDelete.length} old agents...`);
for (const a of toDelete) {
  const id = (a['name'] as string).split('/').pop();
  const del = await fetch(`${base}/agents/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  console.log(`  DELETE ${id} "${a['displayName']}": ${del.status} ${del.ok ? '✓' : await del.text()}`);
}

// ── Re-register the v3 agent ──────────────────────────────────────────────────
console.log('\nRe-registering v3 agent...');
const body = {
  displayName: 'Confluence Knowledge Agent',
  description: 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR)',
  adkAgentDefinition: { reasoningEngine: NEW_RE },
};
const reg = await fetch(`${base}/agents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const regText = await reg.text();
console.log(`Register: ${reg.status}: ${regText.slice(0, 400)}`);

if (reg.ok) {
  const regJson = JSON.parse(regText) as Record<string, unknown>;
  const newId = (regJson['name'] as string).split('/').pop();
  console.log(`\nNew agent ID: ${newId}`);
  console.log(`State: ${regJson['state']}`);

  // Share with all users
  const shareRes = await fetch(`${base}/agents/${newId}?updateMask=sharingConfig`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
  });
  console.log(`Share ALL_USERS: ${shareRes.status} ${shareRes.ok ? '✓' : await shareRes.text()}`);
}
