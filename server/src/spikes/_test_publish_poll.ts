/**
 * Create agent with Confluence DS tool, call :publish, poll state for 2 min.
 * Hypothesis: :publish triggers async state transition to ENABLED.
 * Also tries PATCH state=ENABLED directly.
 *
 * Run: cd server && npx tsx src/spikes/_test_publish_poll.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const CF_DS = `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/confluence-knowledge-agent-all`;

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

// Create agent
console.log('[1] Creating agent with Confluence DS tool...');
const cr = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'Confluence Agent (publish-poll test)',
    description: 'Testing async state transition via :publish',
    starterPrompts: [{ text: 'What is the sick leave policy?' }],
    lowCodeAgentDefinition: {
      rootAgentId: 'root',
      nodes: [{
        id: 'root', displayName: 'Root',
        llmAgentNode: {
          model: 'gemini-2.5-flash',
          instruction: 'You are a helpful assistant. Use the Confluence knowledge base to answer questions accurately.',
          subAgentIds: [],
          selectedTools: { tool: [{ name: CF_DS }] },
        },
      }],
    },
  }),
});
const cj = await cr.json() as Record<string, unknown>;
console.log(`  Create: ${cr.status}, state=${cj['state']}`);
if (!cr.ok) { console.error(JSON.stringify(cj)); process.exit(1); }
const agentId = String(cj['name']).split('/').pop()!;

// Call :publish
console.log('\n[2] Calling :publish...');
const pr = await fetch(`${agentBase}/${agentId}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const pj = await pr.json() as Record<string, unknown>;
console.log(`  :publish: ${pr.status}, returned state=${pj['state']}`);

// Also try PATCH state=ENABLED directly
console.log('\n[3] PATCH state=ENABLED directly...');
const patchR = await fetch(`${agentBase}/${agentId}?updateMask=state`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: 'ENABLED' }),
});
const patchJ = await patchR.json() as Record<string, unknown>;
console.log(`  PATCH state: ${patchR.status}`);
if (!patchR.ok) {
  const errMsg = String((patchJ['error'] as Record<string, unknown>)?.['message'] ?? '');
  console.log(`  Error: ${errMsg.slice(0, 200)}`);
} else {
  console.log(`  Returned state: ${patchJ['state']}`);
}

// Poll state for 2 minutes
console.log('\n[4] Polling state every 10s for 2 min...');
let finalState = 'PRIVATE';
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 10000));
  const gr = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const gj = await gr.json() as Record<string, unknown>;
  const state = String(gj['state'] ?? 'unknown');
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts}] state: ${state}`);
  finalState = state;
  if (state === 'ENABLED') {
    console.log('\n✅ ENABLED! Async transition works!');
    // Share with all users
    await fetch(`${agentBase}/${agentId}?updateMask=sharingConfig`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
    });
    console.log('  Shared with ALL_USERS — test in business.gemini.google!');
    break;
  }
}

if (finalState !== 'ENABLED') {
  console.log(`\n❌ State never changed to ENABLED after 2 min. Final state: ${finalState}`);
  console.log(`  Agent ${agentId} still exists in Agentspace (PRIVATE — not visible to users)`);
  // Delete
  await fetch(`${agentBase}/${agentId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
  console.log('  Cleaned up.');
}
