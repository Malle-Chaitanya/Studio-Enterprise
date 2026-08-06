/**
 * Test: does the :publish endpoint move a low-code agent from PRIVATE → ENABLED?
 *
 * If yes: we can skip ADK/RE entirely — create low-code agent with Confluence
 * data store attached engine-wide, publish it, share it. Agent becomes ENABLED
 * and searchable in Agentspace with Confluence grounding.
 *
 * Run: cd server && npx tsx src/spikes/_test_publish_agent.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const DATA_STORE_ID = 'cf-knowledge-eng-hr';
const SA_PROJECT = 'studio-enterprise-migration';
// Full resource path — data store lives in studio-enterprise-migration
const DATA_STORE_PATH = `projects/${SA_PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}`;

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
console.log(`Destination: project=${dest.project} engine=${dest.engine} assistant=${dest.assistant}`);

const assistantBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentBase = `${assistantBase}/agents`;
const engineBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;

// ── Step 1: Create a low-code test agent ──────────────────────────────────────
console.log('\n[1] Creating low-code test agent...');
const createBody = {
  displayName: 'Confluence Knowledge Test (publish-spike)',
  description: 'Testing :publish endpoint — spike only, safe to delete',
  starterPrompts: [{ text: 'What is the sick leave policy?' }, { text: 'What are the engineering standards?' }],
  icon: {},
  lowCodeAgentDefinition: {
    rootAgentId: 'root_agent',
    nodes: [{
      id: 'root_agent',
      displayName: 'Confluence Knowledge Test (publish-spike)',
      llmAgentNode: {
        description: 'Knowledge assistant grounded on Confluence',
        model: 'gemini-2.5-flash',
        instruction: 'You are a helpful assistant. Answer questions using the knowledge sources available. Cite your sources when possible.',
        subAgentIds: [],
        selectedTools: { tool: [] },
      },
    }],
    draftDisplayName: 'Confluence Knowledge Test (publish-spike)',
    draftDescription: 'Testing :publish endpoint',
    draftStarterPrompts: [{ text: 'What is the sick leave policy?' }],
    draftIcon: { content: '' },
    deployedNodes: [],
    agentFiles: [],
    draftSchedules: [],
    deployedSchedules: [],
  },
};

const cr = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(createBody),
});
const ct = await cr.text();
console.log(`  Create status: ${cr.status}`);
if (!cr.ok) {
  console.error(`  Create failed: ${ct.slice(0, 400)}`);
  process.exit(1);
}
const created = JSON.parse(ct) as { name?: string; state?: string };
const agentId = created.name?.split('/').pop() ?? '';
console.log(`  Agent ID: ${agentId}`);
console.log(`  Initial state: ${created.state ?? 'not returned'}`);

// ── Step 2: GET agent to confirm current state ────────────────────────────────
console.log('\n[2] GET agent to confirm state...');
const gr = await fetch(`${agentBase}/${agentId}`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const gj = await gr.json() as Record<string, unknown>;
console.log(`  state: ${gj['state']}`);
console.log(`  displayName: ${gj['displayName']}`);

// ── Step 3: Call :publish ─────────────────────────────────────────────────────
console.log('\n[3] Calling :publish...');
const pr = await fetch(`${agentBase}/${agentId}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const pt = await pr.text();
console.log(`  publish status: ${pr.status}`);
if (!pr.ok) {
  console.log(`  publish error: ${pt.slice(0, 400)}`);
} else {
  try {
    const pj = JSON.parse(pt) as Record<string, unknown>;
    console.log(`  publish response: ${JSON.stringify(pj).slice(0, 300)}`);
  } catch {
    console.log(`  publish response (raw): ${pt.slice(0, 300)}`);
  }
}

// ── Step 4: GET agent again — did state change? ───────────────────────────────
console.log('\n[4] GET agent after :publish...');
await new Promise(r => setTimeout(r, 3000));
const gr2 = await fetch(`${agentBase}/${agentId}`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const gj2 = await gr2.json() as Record<string, unknown>;
console.log(`  state after publish: ${gj2['state']}`);

const publishWorked = gj2['state'] === 'ENABLED';
if (publishWorked) {
  console.log('  ✅ :publish moved agent to ENABLED!');
} else {
  console.log(`  ❌ State still ${gj2['state']} — :publish did not enable agent`);
}

// ── Step 5: Attach Confluence data store to engine (engine-wide grounding) ────
console.log('\n[5] Attaching Confluence data store to engine...');
const getEng = await fetch(engineBase, { headers: { Authorization: `Bearer ${saToken}` } });
const engJ = await getEng.json() as Record<string, unknown>;
const existing = (engJ['searchEngineConfig'] as Record<string, unknown> | undefined)?.['searchTier'];
console.log(`  Engine search tier: ${existing ?? 'not set'}`);
const existingDs = (engJ as Record<string, unknown[]>)['dataStoreIds'] ?? [];
console.log(`  Existing dataStoreIds: ${JSON.stringify(existingDs)}`);

if (!existingDs.includes(DATA_STORE_ID)) {
  console.log(`  Patching engine to add data store...`);
  const patchBody = { dataStoreIds: [...existingDs, DATA_STORE_ID] };
  const patchR = await fetch(`${engineBase}?updateMask=dataStoreIds`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  });
  const patchT = await patchR.text();
  console.log(`  Patch status: ${patchR.status}`);
  if (!patchR.ok) console.log(`  Patch error: ${patchT.slice(0, 300)}`);
  else {
    const pj = JSON.parse(patchT) as Record<string, unknown[]>;
    console.log(`  New dataStoreIds: ${JSON.stringify(pj['dataStoreIds'] ?? pj)}`);
  }
} else {
  console.log(`  Data store already attached.`);
}

// ── Step 6: Share the agent ───────────────────────────────────────────────────
console.log('\n[6] Sharing agent...');
const sr = await fetch(`${agentBase}/${agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`  Share status: ${sr.status}`);

// ── Step 7: Final state check ─────────────────────────────────────────────────
console.log('\n[7] Final agent state...');
const fr = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
const fj = await fr.json() as Record<string, unknown>;
console.log(`  state: ${fj['state']}`);
console.log(`  sharingConfig: ${JSON.stringify(fj['sharingConfig'])}`);

console.log('\n══════════════════════════════════════════════════════');
if (publishWorked) {
  console.log('✅ PUBLISH WORKS — low-code path viable!');
  console.log(`   Agent: ${agentId}`);
  console.log(`   Test: business.gemini.google → "What is the sick leave policy?"`);
  console.log('   If grounding works: use createAgent + publishAgent in orchestrator.');
  console.log('   No ADK/RE needed.');
} else {
  console.log('❌ PUBLISH DID NOT ENABLE AGENT');
  console.log(`   Final state: ${fj['state']}`);
  console.log('   Try: manual publish from Gemini Business console + check if :publish needs extra params');
}
console.log('══════════════════════════════════════════════════════');
console.log(`\nClean up: DELETE ${agentBase}/${agentId}`);
