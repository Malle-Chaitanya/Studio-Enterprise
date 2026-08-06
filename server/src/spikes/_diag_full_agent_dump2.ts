/**
 * Print the FULL current state of our Confluence agent vs working agent.
 * Also re-attempt publish and print full response body.
 * Usage: cd server && npx tsx src/spikes/_diag_full_agent_dump2.ts
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

// Full agent dump
const res = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
const body = await res.text();
console.log('=== GET agent (full) ===');
console.log(body);

// Re-attempt publish and print full body
console.log('\n\n=== POST :publish (full response) ===');
const pub = await fetch(`${agentUrl}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const pubBody = await pub.text();
console.log(`status: ${pub.status}`);
console.log(pubBody);

// Test share after publish
console.log('\n\n=== PATCH sharingConfig ===');
const share = await fetch(`${agentUrl}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
const shareBody = await share.text();
console.log(`status: ${share.status}`);
console.log(shareBody.slice(0, 600));
