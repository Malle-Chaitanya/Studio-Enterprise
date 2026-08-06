/**
 * Inspect a console-created ENABLED agent to understand its API structure.
 *
 * PREREQUISITE: User must manually create ONE agent in business.gemini.google:
 *   1. Go to business.gemini.google → Agentspace
 *   2. Create agent → add "Confluence" as a knowledge connector
 *   3. Publish the agent
 *   4. Note the agent name (displayName)
 *   5. Run this script: it will find and inspect it
 *
 * Run: cd server && npx tsx src/spikes/_inspect_console_agent.ts
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
const j = await r.json() as { agents?: Array<{ name: string; displayName: string; state: string }> };
const agents = j.agents ?? [];
console.log(`Found ${agents.length} agents:`);
for (const a of agents) {
  console.log(`  [${a.state}] ${a.name.split('/').pop()} — "${a.displayName}"`);
}

const enabledAgents = agents.filter(a => a.state === 'ENABLED');
if (enabledAgents.length === 0) {
  console.log('\n⚠️  No ENABLED agents found.');
  console.log('Please create an agent in business.gemini.google and publish it first.');
  console.log('Then re-run this script.');
  process.exit(0);
}

// GET full definition of each ENABLED agent
console.log(`\n─── ENABLED agent full definitions ───`);
for (const a of enabledAgents) {
  const agentId = a.name.split('/').pop()!;
  console.log(`\nAgent: "${a.displayName}" (${agentId})`);
  const gr = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const gj = await gr.json() as Record<string, unknown>;
  console.log(JSON.stringify(gj, null, 2));
}
