/**
 * List all agents and delete test/spike ones to clear rate limit headroom.
 * Run: cd server && npx tsx src/spikes/_list_cleanup_agents.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

// List all agents
const r = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
const j = await r.json() as { agents?: Array<{ name: string; displayName: string; state: string; description?: string }> };
const agents = j.agents ?? [];
console.log(`Found ${agents.length} agents:`);
for (const a of agents) {
  const id = a.name.split('/').pop();
  console.log(`  [${a.state}] ${id} — "${a.displayName}"`);
}

// Delete obvious test/spike agents (keep real ones)
const testKeywords = ['test', 'spike', 'publish-spike', 'deployed-nodes', 'v8-reg', 'same-project', 'debug'];
const toDelete = agents.filter(a => {
  const dn = a.displayName.toLowerCase();
  const desc = (a.description ?? '').toLowerCase();
  return testKeywords.some(k => dn.includes(k) || desc.includes(k));
});

if (toDelete.length === 0) {
  console.log('\nNo test agents to delete.');
} else {
  console.log(`\nDeleting ${toDelete.length} test agents...`);
  for (const a of toDelete) {
    const id = a.name.split('/').pop();
    const dr = await fetch(`${agentBase}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${saToken}` },
    });
    console.log(`  DELETE ${id} ("${a.displayName}"): ${dr.status}`);
    await new Promise(r => setTimeout(r, 500));
  }
}

console.log('\nRemaining agents:');
const r2 = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
const j2 = await r2.json() as { agents?: Array<{ name: string; displayName: string; state: string }> };
for (const a of (j2.agents ?? [])) {
  const id = a.name.split('/').pop();
  console.log(`  [${a.state}] ${id} — "${a.displayName}"`);
}
