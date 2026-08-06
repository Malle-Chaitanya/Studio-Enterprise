/**
 * Create a low-code agent with deployedNodes pre-populated.
 * Hypothesis: creating with deployedNodes=nodes might result in ENABLED state
 * instead of PRIVATE (bypasses the draft → publish flow).
 *
 * Run: cd server && npx tsx src/spikes/_test_agent_deployed_nodes.ts
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

const nodeConfig = {
  id: 'root_agent',
  displayName: 'Confluence Test (deployed-nodes)',
  llmAgentNode: {
    description: 'Knowledge assistant grounded on Confluence',
    model: 'gemini-2.5-flash',
    instruction: 'You are a helpful assistant. Answer questions using available knowledge. Cite sources.',
    subAgentIds: [],
    selectedTools: { tool: [] },
  },
};

// Create with deployedNodes pre-populated (same as nodes)
console.log('[1] Creating agent with deployedNodes pre-populated...');
const r = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'Confluence Test (deployed-nodes)',
    description: 'Testing if pre-populated deployedNodes bypasses PRIVATE state',
    starterPrompts: [{ text: 'What is the sick leave policy?' }],
    icon: {},
    lowCodeAgentDefinition: {
      rootAgentId: 'root_agent',
      nodes: [nodeConfig],
      // Pre-populate deployedNodes with the same node
      deployedNodes: [nodeConfig],
      draftDisplayName: 'Confluence Test (deployed-nodes)',
      draftDescription: 'Testing deployedNodes',
      draftStarterPrompts: [{ text: 'What is the sick leave policy?' }],
      draftIcon: { content: '' },
      agentFiles: [],
      draftSchedules: [],
      deployedSchedules: [],
    },
  }),
});
const t = await r.text();
console.log(`  Create status: ${r.status}`);
const j = JSON.parse(t) as Record<string, unknown>;
const agentId = String(j['name']).split('/').pop();
console.log(`  Agent ID: ${agentId}`);
console.log(`  Initial state: ${j['state']}`);

// Wait and GET
await new Promise(r => setTimeout(r, 2000));
console.log('\n[2] GET agent state...');
const gr = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
const gj = await gr.json() as Record<string, unknown>;
console.log(`  state: ${gj['state']}`);
const lcd = gj['lowCodeAgentDefinition'] as Record<string, unknown> | undefined;
console.log(`  deployedNodes: ${JSON.stringify(lcd?.['deployedNodes'])?.slice(0, 100)}`);

// Try publish
console.log('\n[3] Calling :publish...');
const pr = await fetch(`${agentBase}/${agentId}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
console.log(`  publish status: ${pr.status}`);

await new Promise(r => setTimeout(r, 2000));
console.log('\n[4] GET agent state after publish...');
const gr2 = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
const gj2 = await gr2.json() as Record<string, unknown>;
console.log(`  state: ${gj2['state']}`);

if (gj2['state'] === 'ENABLED') {
  console.log('\n✅ ENABLED! deployedNodes approach works!');
  console.log('  Sharing...');
  await fetch(`${agentBase}/${agentId}?updateMask=sharingConfig`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
  });
  console.log(`  → business.gemini.google → "Confluence Test (deployed-nodes)" → test it!`);
} else {
  console.log(`\n❌ Still ${gj2['state']} — deployedNodes alone doesn't enable agent`);
  console.log(`  Clean up: DELETE ${agentBase}/${agentId}`);
}
