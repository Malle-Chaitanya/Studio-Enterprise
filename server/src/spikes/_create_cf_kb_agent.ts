/**
 * Create low-code agent in studio-enterprise-migration backed by cf-knowledge-eng-hr.
 * Run: cd server && npx tsx src/spikes/_create_cf_kb_agent.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const DS_ID = 'cf-knowledge-eng-hr';
const GEMINI_ENGINE = 'gemini-enterprise-17847887_1784788734248';
const QUESTION = 'What is the sick leave policy?';

async function getSaToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const client = new JWT({
    email: key.client_email, key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('No token');
  return access_token;
}

const saToken = await getSaToken();
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${GEMINI_ENGINE}`;
const agentBase = `${engineBase}/assistants/default_assistant/agents`;

// ── 1. Get project number for resource path ────────────────────────────────────
console.log('═══ 1. Get project number ═══');
const projR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${GCP_PROJECT}`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
const projJ = await projR.json() as { projectNumber?: string; projectId?: string };
const projectNumber = projJ.projectNumber ?? GCP_PROJECT;
console.log(`Project ID    : ${projJ.projectId}`);
console.log(`Project Number: ${projectNumber}`);

// Full data store resource path (uses project number)
const dsResourcePath = `projects/${projectNumber}/locations/global/collections/default_collection/dataStores/${DS_ID}`;
console.log(`DataStore path: ${dsResourcePath}`);

// ── 2. Check if agent already exists (idempotency) ────────────────────────────
console.log('\n═══ 2. Check existing agents ═══');
const listR = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
const listJ = await listR.json() as { agents?: Array<{ name: string; displayName?: string; state?: string }> };
const DISPLAY_NAME = 'Confluence Knowledge Agent';
const existing = (listJ.agents ?? []).find(a => a.displayName === DISPLAY_NAME);
if (existing) {
  const agentId = existing.name.split('/').pop()!;
  console.log(`Agent already exists: ${agentId} (${existing.state}) — skipping create`);
  console.log(`\nTo test: ask "${QUESTION}" in business.gemini.google → Agents → ${DISPLAY_NAME}`);
  process.exit(0);
}
console.log('No existing agent with that name — creating...');

// ── 3. Create agent with dataStoreSpecs ───────────────────────────────────────
console.log('\n═══ 3. Create agent ═══');
const rootNode = {
  id: 'root_agent',
  displayName: DISPLAY_NAME,
  llmAgentNode: {
    description: 'Answers questions from Confluence knowledge base (Engineering + HR spaces).',
    model: 'gemini-2.5-flash',
    instruction:
      'You are a helpful company assistant grounded in the company Confluence knowledge base. ' +
      'Use the connected data store to answer questions accurately. ' +
      'Always cite the Confluence page title (e.g., "According to HR-leave-policy...") when answering. ' +
      'If the answer is not in the knowledge base, say clearly: "I don\'t have that information in the knowledge base."',
    subAgentIds: [] as string[],
    dataStoreSpecs: {
      specs: [{ dataStore: dsResourcePath }],
    },
    selectedTools: { tool: [{ name: 'googleSearch' }] },
  },
};

const agentBody = {
  displayName: DISPLAY_NAME,
  description: 'Low-code agent grounded on Confluence ENG + HR spaces via dataStoreSpecs. Created by CloudFuze Studio Migrate.',
  starterPrompts: [
    { text: 'What is the sick leave policy?' },
    { text: 'What are the Python coding standards?' },
    { text: 'How do engineers deploy code to production?' },
    { text: 'How many days of annual leave do I get?' },
  ],
  icon: {},
  lowCodeAgentDefinition: {
    rootAgentId: 'root_agent',
    nodes: [rootNode],
    deployedNodes: [rootNode],
    deployedRootAgentId: 'root_agent',
    draftDisplayName: DISPLAY_NAME,
    draftDescription: 'Confluence ENG + HR knowledge base agent.',
    draftStarterPrompts: [
      { text: 'What is the sick leave policy?' },
      { text: 'What are the Python coding standards?' },
    ],
    draftIcon: { content: '' },
    agentFiles: [],
    draftSchedules: [],
    deployedSchedules: [],
  },
};

const createR = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(agentBody),
});
const createT = await createR.text();
console.log(`Create status: ${createR.status}`);

if (!createR.ok) {
  console.error(`❌ Create failed: ${createT.slice(0, 400)}`);
  process.exit(1);
}

const created = JSON.parse(createT) as Record<string, unknown>;
const agentId = String(created['name']).split('/').pop()!;
console.log(`✅ Agent created!`);
console.log(`   ID     : ${agentId}`);
console.log(`   State  : ${created['state']}`);
console.log(`   Name   : ${created['displayName']}`);

// ── 4. Verify dataStoreSpecs wired ────────────────────────────────────────────
console.log('\n═══ 4. Verify agent definition ═══');
const lcd = created['lowCodeAgentDefinition'] as Record<string, unknown> | undefined;
const nodes = (lcd?.['nodes'] as Array<Record<string, unknown>>) ?? [];
const rootN = nodes.find(n => n['id'] === 'root_agent');
const llmN = rootN?.['llmAgentNode'] as Record<string, unknown> | undefined;
const dsSpecs = llmN?.['dataStoreSpecs'] as Record<string, unknown> | undefined;
const specs = (dsSpecs?.['specs'] as Array<Record<string, unknown>>) ?? [];
console.log(`dataStoreSpecs: ${specs.length > 0
  ? '✅ ' + specs.map(s => String(s['dataStore']).split('/').pop()).join(', ')
  : '❌ missing'}`);

// ── 5. Publish the agent ──────────────────────────────────────────────────────
console.log('\n═══ 5. Publish agent ═══');
const pubR = await fetch(`${agentBase}/${agentId}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
const pubT = await pubR.text();
console.log(`Publish: ${pubR.status}`);
if (pubR.ok) {
  const pubJ = JSON.parse(pubT) as Record<string, unknown>;
  console.log(`State after publish: ${pubJ['state'] ?? '(check in UI)'}`);
} else {
  console.log(`Publish response: ${pubT.slice(0, 200)}`);
  console.log('(Publish via API may not change state — admin must click Publish in Agentspace UI)');
}

// ── 6. Test via RAG ────────────────────────────────────────────────────────────
console.log('\n═══ 6. Test knowledge base answers ═══');
const VTXAI = 'https://us-central1-aiplatform.googleapis.com';
const MODEL = 'gemini-2.5-flash';

for (const q of [QUESTION, 'What are the Python coding standards?', 'How do engineers deploy?']) {
  const srchR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, pageSize: 2, contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 2 } } }),
  });
  const srchJ = await srchR.json() as { results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }> };
  const ctx: string[] = [];
  for (const r of srchJ.results ?? []) {
    const sd = r.document?.derivedStructData ?? {};
    const title = sd['title'] as string ?? '';
    const snips = sd['snippets'] as Array<{ snippet?: string; snippet_status?: string }> ?? [];
    const snip = snips.filter(s => s.snippet_status === 'SUCCESS').map(s => s.snippet?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&') ?? '').join(' ');
    if (snip) ctx.push(`[${title}]: ${snip}`);
  }
  if (ctx.length === 0) { console.log(`\nQ: ${q}\n  (no results)`); continue; }
  const gemR = await fetch(`${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Answer using ONLY this knowledge base:\n${ctx.join('\n')}\n\nQ: ${q}\nA:` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 200 },
    }),
  });
  if (gemR.ok) {
    const j = await gemR.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    console.log(`\nQ: ${q}\n✅ A: ${j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)'}`);
  }
}

console.log(`
════════════════════════════════════════════
  AGENT CREATED ✅
════════════════════════════════════════════
  Agent ID  : ${agentId}
  Data store: ${DS_ID} (Confluence ENG + HR)
  State     : ${created['state']}

  Test in Agentspace UI:
  → console.cloud.google.com/gemini-enterprise
  → Project: studio-enterprise-migration
  → Agents → "${DISPLAY_NAME}"
  → Click "Chat" to test

  If state is PRIVATE, click Publish in the UI.
════════════════════════════════════════════
`);
