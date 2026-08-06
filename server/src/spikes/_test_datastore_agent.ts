/**
 * End-to-end test: create agent with dataStoreSpecs pointing to the
 * pre-ingested Confluence data store, verify it's created, list it.
 *
 * This verifies Path A: data store → agent via dataStoreSpecs.
 *
 * Run: cd server && npx tsx src/spikes/_test_datastore_agent.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT     = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN    = 'mia@cloudfuze.com';
const HOST            = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global` +
  `/collections/default_collection/engines/${dest.engine}` +
  `/assistants/${dest.assistant}/agents`;

// ── 1. Check what data stores exist ──────────────────────────────────────────
console.log('═══ 1. List data stores ═══');
const dsUrl = `${HOST}/projects/${GCP_PROJECT}/locations/global` +
  `/collections/default_collection/dataStores`;
const dsR = await fetch(dsUrl, { headers: { Authorization: `Bearer ${saToken}` } });
const dsJ = await dsR.json() as { dataStores?: Array<{ name: string; displayName?: string; documentCount?: number }> };
const stores = dsJ.dataStores ?? [];
console.log(`Found ${stores.length} data store(s):`);
for (const ds of stores) {
  const id = ds.name.split('/').pop()!;
  console.log(`  ${id}  (docs: ${ds.documentCount ?? '?'})`);
}

// Pick the pre-ingested Confluence store
const cfStore = stores.find(ds => ds.name.includes('confluence-knowledge-agent-all'));
if (!cfStore) {
  console.log('\n⚠ confluence-knowledge-agent-all not found — checking if a crawl is needed.');
  console.log('  Run the migration tool with Confluence credentials to create the data store first.');
  process.exit(1);
}

const cfResourcePath = `projects/${GCP_PROJECT_NUM}/locations/global` +
  `/collections/default_collection/dataStores/confluence-knowledge-agent-all`;
console.log(`\n✅ Using: ${cfResourcePath}`);

// ── 2. Create agent with dataStoreSpecs ──────────────────────────────────────
console.log('\n═══ 2. Create agent with dataStoreSpecs ═══');
const rootNode = {
  id: 'root_agent',
  displayName: 'Confluence Test Agent',
  llmAgentNode: {
    description: 'Answers questions from Confluence knowledge base.',
    model: 'gemini-2.5-flash',
    instruction:
      'You are a helpful assistant. Use the connected Confluence knowledge base to answer ' +
      'questions accurately. Always cite your source page title when answering.',
    subAgentIds: [],
    selectedTools: { tool: [{ name: 'googleSearch' }] },
    dataStoreSpecs: {
      specs: [{ dataStore: cfResourcePath }],
    },
  },
};

const body = {
  displayName: 'Confluence Test Agent (Path A)',
  description: 'Test: pre-ingested Confluence data store via dataStoreSpecs.',
  starterPrompts: [
    { text: 'What is the sick leave policy?' },
    { text: 'What are our engineering standards?' },
    { text: 'Tell me about the company wiki.' },
  ],
  icon: {},
  lowCodeAgentDefinition: {
    rootAgentId: 'root_agent',
    nodes: [rootNode],
    deployedNodes: [rootNode],
    deployedRootAgentId: 'root_agent',
    draftDisplayName: 'Confluence Test Agent (Path A)',
    draftDescription: 'Test: pre-ingested Confluence data store via dataStoreSpecs.',
    draftStarterPrompts: [{ text: 'What is the sick leave policy?' }, { text: 'What are our engineering standards?' }],
    draftIcon: { content: '' },
    agentFiles: [],
    draftSchedules: [],
    deployedSchedules: [],
  },
};

const createR = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const createT = await createR.text();
console.log(`Create status: ${createR.status}`);

if (!createR.ok) {
  console.log(`Error: ${createT.slice(0, 400)}`);
  process.exit(1);
}

const created = JSON.parse(createT) as Record<string, unknown>;
const agentId = String(created['name']).split('/').pop()!;
console.log(`✅ Created: id=${agentId}  state=${created['state']}`);

// ── 3. Try :publish ───────────────────────────────────────────────────────────
console.log('\n═══ 3. Attempt :publish ═══');
const pubR = await fetch(`${agentBase}/${agentId}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
console.log(`publish: ${pubR.status}`);
await new Promise(r => setTimeout(r, 3000));

// ── 4. Read back state ────────────────────────────────────────────────────────
const getR = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
const getJ = await getR.json() as Record<string, unknown>;
console.log(`State after publish: ${getJ['state']}`);

// ── 5. List all agents ────────────────────────────────────────────────────────
console.log('\n═══ 5. All agents ═══');
const listR = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
const listJ = await listR.json() as { agents?: Array<{ name: string; displayName: string; state: string }> };
for (const a of listJ.agents ?? []) {
  const id = a.name.split('/').pop()!;
  console.log(`  [${a.state}] ${id} — "${a.displayName}"`);
}

console.log(`
═══ RESULT ═══
Agent ID : ${agentId}
State    : ${getJ['state']}

Next step: open business.gemini.google → Agents gallery → find "Confluence Test Agent (Path A)"
  - If PRIVATE → click the agent → Publish → test with "What is the sick leave policy?"
  - If ENABLED → test directly from the gallery

If the agent answers using Confluence content → Path A dataStoreSpecs works.
`);
