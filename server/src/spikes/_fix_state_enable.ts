/**
 * Try to PATCH state=ENABLED directly, then check current state.
 * Usage: cd server && npx tsx src/spikes/_fix_state_enable.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_ID     = '8980160511526117673';
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentUrl = `${assistantBase}/agents/${AGENT_ID}`;

// Try PATCH state=ENABLED
console.log('PATCH state=ENABLED…');
const r1 = await fetch(`${agentUrl}?updateMask=state`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: 'ENABLED' }),
});
const t1 = await r1.text();
console.log(`  status: ${r1.status}`);
console.log(`  body: ${t1.slice(0, 400)}`);

// Verify
const r2 = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
const j2 = await r2.json() as Record<string, unknown>;
console.log(`\nAfter PATCH: state=${j2.state}`);
const lcd = j2.lowCodeAgentDefinition as Record<string, unknown> | undefined;
console.log(`deployedNodes: ${(lcd?.deployedNodes as unknown[])?.length ?? 0}`);
console.log(`agentFiles:    ${(lcd?.agentFiles as unknown[])?.length ?? 0}`);
