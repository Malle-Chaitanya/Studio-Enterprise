/**
 * Create agent using the correct dataStoreSpecs structure (learned from console agent).
 * Tests two approaches:
 *   A) Use the connector-created hybrid data stores (same as console agent)
 *   B) Use our pre-ingested confluence-knowledge-agent-all data store
 *
 * Run: cd server && npx tsx src/spikes/_create_connector_agent.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

// Data stores discovered from the console agent's definition
const HYBRID_DS = [
  `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/agentspace-hybrid-atlassian-confluence_space4352`,
  `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/agentspace-hybrid-atlassian-confluence_page1534`,
  `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/agentspace-hybrid-atlassian-confluence_comment5059`,
  `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/agentspace-hybrid-atlassian-confluence_attachment1120`,
  `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/agentspace-hybrid-atlassian-confluence_blog3085`,
];

const PRE_INGESTED_DS = [
  `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/confluence-knowledge-agent-all`,
];

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

function makeAgentBody(displayName: string, description: string, dataStores: string[]) {
  const nodeConfig = {
    id: 'root_agent',
    displayName,
    llmAgentNode: {
      description,
      model: 'gemini-2.5-flash',
      instruction: 'You are a helpful assistant. Use the knowledge sources to answer questions accurately. Always cite your sources.',
      selectedTools: { tool: [{ name: 'googleSearch' }] },
      dataStoreSpecs: {
        specs: dataStores.map(ds => ({ dataStore: ds })),
      },
    },
  };

  return {
    displayName,
    description,
    icon: { content: '' },
    starterPrompts: [
      { text: 'What is the sick leave policy?' },
      { text: 'What is the PTO policy?' },
      { text: 'Tell me about our engineering standards' },
    ],
    lowCodeAgentDefinition: {
      rootAgentId: 'root_agent',
      nodes: [nodeConfig],
      deployedNodes: [nodeConfig],           // pre-populate (as console does)
      deployedRootAgentId: 'root_agent',     // pre-populate (as console does)
      draftDisplayName: displayName,
      draftDescription: description,
      draftIcon: { content: '' },
    },
  };
}

// ── Test A: Hybrid connector data stores (exactly what console agent uses) ────
console.log('═══ A: Hybrid connector data stores ═══');
const bodyA = makeAgentBody(
  'Confluence Knowledge Agent (hybrid)',
  'Confluence knowledge via OAuth connector — ENG, HR, and all spaces',
  HYBRID_DS
);
const rA = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(bodyA),
});
const tA = await rA.text();
console.log(`Create: ${rA.status}`);
if (rA.ok) {
  const jA = JSON.parse(tA) as Record<string, unknown>;
  const idA = String(jA['name']).split('/').pop()!;
  console.log(`  state=${jA['state']}, id=${idA}`);

  // Try publish
  const prA = await fetch(`${agentBase}/${idA}:publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log(`  :publish: ${prA.status}`);
  await new Promise(r => setTimeout(r, 3000));
  const grA = await fetch(`${agentBase}/${idA}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const gjA = await grA.json() as Record<string, unknown>;
  console.log(`  state after publish: ${gjA['state']}`);

  if (gjA['state'] === 'ENABLED') {
    console.log('\n🎉 ENABLED! Sharing with all users...');
    await fetch(`${agentBase}/${idA}?updateMask=sharingConfig`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
    });
    console.log('  Done! Test in business.gemini.google → Agents gallery');
  } else {
    console.log(`  Still ${gjA['state']} — keeping for testing (id: ${idA})`);
    console.log('  You can access this agent directly at business.gemini.google (draft mode)');
    // Don't delete — let user test
  }
} else {
  console.log(`  Error: ${tA.slice(0, 300)}`);
}

await new Promise(r => setTimeout(r, 2000));

// ── Test B: Pre-ingested data store ──────────────────────────────────────────
console.log('\n═══ B: Pre-ingested data store ═══');
const bodyB = makeAgentBody(
  'Confluence Knowledge Agent (pre-ingested)',
  'Confluence knowledge from pre-ingested data store',
  PRE_INGESTED_DS
);
const rB = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(bodyB),
});
const tB = await rB.text();
console.log(`Create: ${rB.status}`);
if (rB.ok) {
  const jB = JSON.parse(tB) as Record<string, unknown>;
  const idB = String(jB['name']).split('/').pop()!;
  console.log(`  state=${jB['state']}, id=${idB}`);

  const prB = await fetch(`${agentBase}/${idB}:publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log(`  :publish: ${prB.status}`);
  await new Promise(r => setTimeout(r, 3000));
  const grB = await fetch(`${agentBase}/${idB}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const gjB = await grB.json() as Record<string, unknown>;
  console.log(`  state after publish: ${gjB['state']}`);

  if (gjB['state'] !== 'ENABLED') {
    // Delete since we have a better one
    await fetch(`${agentBase}/${idB}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
    console.log('  (deleted — prefer hybrid connector approach)');
  }
} else {
  console.log(`  Error: ${tB.slice(0, 300)}`);
}

// ── List all agents ────────────────────────────────────────────────────────
console.log('\n═══ Current agents ═══');
const lr = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
const lj = await lr.json() as { agents?: Array<{ name: string; displayName: string; state: string }> };
for (const a of lj.agents ?? []) {
  console.log(`  [${a.state}] ${a.name.split('/').pop()} — "${a.displayName}"`);
}
