/**
 * Throwaway diag: capture the REAL state of migrated agents in a Gemini project.
 * Mints an SA token (DWD-impersonating the given admin), lists engines, then lists
 * each engine's agents and prints their raw state + sharingConfig — hard evidence,
 * no inference.
 *   cd server && npx tsx src/spikes/_diag_agent_states.ts [project] [impersonateEmail] [assistant]
 * defaults: project=521161651560  email=mia@cloudfuze.com  assistant=default_assistant
 */
import { getSaToken } from '../auth/google.js';

const project = process.argv[2] || '521161651560';
const email = process.argv[3] || 'mia@cloudfuze.com';
const assistant = process.argv[4] || 'default_assistant';
const BASE = 'https://discoveryengine.googleapis.com/v1alpha';

function h(t: string) {
  return { Authorization: `Bearer ${t}` };
}

let token: string;
try {
  token = await getSaToken(email); // DWD impersonation (no-org managed project)
  console.log(`✓ SA token minted (impersonating ${email})`);
} catch (e) {
  console.error(`✗ could not mint SA token impersonating ${email}: ${(e as Error).message}`);
  console.error('  (DWD may not be authorized for this account/domain, or the guard/allowlist blocked it)');
  process.exit(1);
}

const enginesUrl = `${BASE}/projects/${project}/locations/global/collections/default_collection/engines`;
const er = await fetch(enginesUrl, { headers: h(token) });
console.log(`\nGET engines → ${er.status}`);
if (!er.ok) {
  console.error(await er.text());
  process.exit(1);
}
const engines = ((await er.json()) as { engines?: { name: string; displayName?: string; solutionType?: string }[] }).engines ?? [];
console.log(`engines: ${engines.length}`);

for (const eng of engines) {
  console.log(`\n──────── engine: ${eng.displayName ?? eng.name} (${eng.solutionType ?? '?'}) ────────`);
  const agentsUrl = `${BASE}/${eng.name}/assistants/${assistant}/agents`;
  const ar = await fetch(agentsUrl, { headers: h(token) });
  console.log(`GET agents → ${ar.status}  (${agentsUrl})`);
  if (!ar.ok) {
    console.log('  ' + (await ar.text()).slice(0, 300));
    continue;
  }
  const agents = ((await ar.json()) as { agents?: Record<string, unknown>[] }).agents ?? [];
  console.log(`  agents: ${agents.length}`);
  for (const a of agents) {
    const name = String(a.displayName ?? a.name ?? '?');
    const id = String(a.name ?? '').split('/').pop();
    console.log(`\n  • ${name}  [${id}]`);
    console.log(`     state:        ${JSON.stringify((a as { state?: unknown }).state)}`);
    console.log(`     sharingConfig:${JSON.stringify((a as { sharingConfig?: unknown }).sharingConfig)}`);
    // dump every top-level key so we see exactly what the API exposes
    console.log(`     keys:         ${Object.keys(a).join(', ')}`);
  }
}
