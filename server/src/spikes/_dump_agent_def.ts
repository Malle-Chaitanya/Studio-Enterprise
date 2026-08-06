/**
 * Dump full definition of the console-created Confluence connector agent.
 * Run: cd server && npx tsx src/spikes/_dump_agent_def.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const TARGET_ID = '7099475012136461191';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

// Get the agent
const r = await fetch(`${agentBase}/${TARGET_ID}`, { headers: { Authorization: `Bearer ${saToken}` } });
const j = await r.json() as Record<string, unknown>;

console.log('\n════ FULL AGENT DEFINITION ════');
console.log(JSON.stringify(j, null, 2));

// Also try to publish it
console.log('\n════ CALLING :publish ════');
const pr = await fetch(`${agentBase}/${TARGET_ID}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const pt = await pr.text();
console.log(`publish status: ${pr.status}`);
console.log(pt.slice(0, 500));

// Poll state after publish
await new Promise(r => setTimeout(r, 3000));
const gr = await fetch(`${agentBase}/${TARGET_ID}`, { headers: { Authorization: `Bearer ${saToken}` } });
const gj = await gr.json() as Record<string, unknown>;
console.log(`\nstate after publish: ${gj['state']}`);
