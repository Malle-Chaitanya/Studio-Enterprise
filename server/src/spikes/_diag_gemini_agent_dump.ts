/**
 * Dump full body of Gemini agents in the Business project.
 * Usage: cd server && npx tsx src/spikes/_diag_gemini_agent_dump.ts [agentNameSubstring]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const FILTER  = (process.argv[2] ?? '').toLowerCase();
const PROJECT = '521161651560';
const EMAIL   = 'mia@cloudfuze.com';
const BASE    = 'https://discoveryengine.googleapis.com/v1alpha';

const token = await getSaToken(EMAIL);
console.log(`✓ token (DWD as ${EMAIL})\n`);

// List engines
const er = await fetch(
  `${BASE}/projects/${PROJECT}/locations/global/collections/default_collection/engines`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const engines = ((await er.json()) as { engines?: { name: string; displayName?: string }[] }).engines ?? [];

for (const eng of engines) {
  const agentsUrl = `${BASE}/${eng.name}/assistants/default_assistant/agents?pageSize=50`;
  const ar = await fetch(agentsUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!ar.ok) continue;
  const agents = ((await ar.json()) as { agents?: Record<string, unknown>[] }).agents ?? [];

  for (const a of agents) {
    const name = String(a.displayName ?? '');
    if (FILTER && !name.toLowerCase().includes(FILTER)) continue;

    const id = String(a.name ?? '').split('/').pop();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`Agent: "${name}"  [${id}]  state=${a.state}`);
    console.log('═'.repeat(70));
    console.log(JSON.stringify(a, null, 2));
  }
}
