/**
 * Try registering v7 RE with streamQueryConfig.classMethod = 'stream_query'
 * so Agentspace calls stream_query (in the whitelist) instead of query (not).
 *
 * Run: cd server && npx tsx src/spikes/_test_register_stream_query.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const SA_PROJECT   = 'studio-enterprise-migration';
// v7 RE — already deployed with module-level AgentspaceAdkApp
const V7_RE        = 'projects/231705905417/locations/us-central1/reasoningEngines/3069750153087811584';
const OLD_AGENT_ID = '10956500662100578125'; // v7 agent to delete first

const saTokenOwn = await getSaToken();
const saToken    = await getSaToken(GEMINI_ADMIN);
const dest       = await resolveDestination(GCP_PROJECT, saToken);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

console.log('=== Test: register with streamQueryConfig.classMethod=stream_query ===\n');

// 0. Delete old v7 agent
try {
  const dr = await fetch(`${base}/agents/${OLD_AGENT_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`Delete old agent: ${dr.status}`);
} catch (e) { console.log(`Delete skipped: ${e}`); }

// 1. Try registration with streamQueryConfig
console.log('\nAttempt 1: streamQueryConfig.classMethod = stream_query');
const r1 = await fetch(`${base}/agents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'Confluence Knowledge Agent',
    description: 'Knowledge agent with stream_query config',
    adkAgentDefinition: {
      provisionedReasoningEngine: {
        reasoningEngine: V7_RE,
        streamQueryConfig: { classMethod: 'stream_query' },
      },
    },
  }),
});
const t1 = await r1.text();
console.log(`Status: ${r1.status}`);
const j1 = r1.ok ? JSON.parse(t1) as Record<string, unknown> : null;
if (j1) {
  const agentId1 = String(j1['name']).split('/').pop();
  console.log(`Agent ID: ${agentId1}, State: ${j1['state']}`);
  console.log(`Full response: ${JSON.stringify(j1).slice(0, 500)}`);

  // Share
  await fetch(`${base}/agents/${agentId1}?updateMask=sharingConfig`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
  }).then(r => console.log(`Share: ${r.status}`));

  console.log(`\nAgent ${agentId1} is LIVE. Test in business.gemini.google: "What is the leave policy?"`);
} else {
  console.log(`Error: ${t1.slice(0, 500)}`);
}

// 2. Also try with reasoningEngineConfig at top level
console.log('\nAttempt 2: adkAgentDefinition.reasoningEngineConfig.classMethod = stream_query');
const r2 = await fetch(`${base}/agents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'CF Knowledge Agent (v2 config)',
    description: 'Test v2',
    adkAgentDefinition: {
      provisionedReasoningEngine: { reasoningEngine: V7_RE },
      reasoningEngineConfig: { classMethod: 'stream_query' },
    },
  }),
});
const t2 = await r2.text();
console.log(`Status: ${r2.status}: ${t2.slice(0, 300)}`);

// 3. Try with class_method directly
console.log('\nAttempt 3: adkAgentDefinition.classMethod = stream_query');
const r3 = await fetch(`${base}/agents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'CF Knowledge Agent (v3 config)',
    description: 'Test v3',
    adkAgentDefinition: {
      provisionedReasoningEngine: { reasoningEngine: V7_RE },
      classMethod: 'stream_query',
    },
  }),
});
const t3 = await r3.text();
console.log(`Status: ${r3.status}: ${t3.slice(0, 300)}`);
