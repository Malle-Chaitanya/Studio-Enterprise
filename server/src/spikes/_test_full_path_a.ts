/**
 * Full Path A test — end-to-end:
 *   1. Crawl Confluence spaces with API token credentials
 *   2. Upload pages to GCS
 *   3. Import into Discovery Engine data store
 *   4. Create low-code agent with dataStoreSpecs pointing to that store
 *   5. Report: agent id, state, how to publish and test
 *
 * Set these env vars before running (or put them in server/.env):
 *   CF_BASE_URL=https://yourcompany.atlassian.net
 *   CF_EMAIL=yourname@company.com
 *   CF_API_TOKEN=your-atlassian-api-token
 *   CF_SPACE_NAMES=Engineering,HR Policies     (comma-separated space display names)
 *
 * Run: cd server && npx tsx src/spikes/_test_full_path_a.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { migrateConfluenceToDataStore, type ConfluenceCreds } from '../services/confluenceMigrator.js';

const GCP_PROJECT     = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN    = 'mia@cloudfuze.com';
const HOST            = 'https://discoveryengine.googleapis.com/v1alpha';

// ── Credentials from env ──────────────────────────────────────────────────────
const CF_BASE_URL    = process.env['CF_BASE_URL']    ?? '';
const CF_EMAIL       = process.env['CF_EMAIL']       ?? '';
const CF_API_TOKEN   = process.env['CF_API_TOKEN']   ?? '';
const CF_SPACE_NAMES = (process.env['CF_SPACE_NAMES'] ?? '').split(',').map(s => s.trim()).filter(Boolean);

if (!CF_BASE_URL || !CF_EMAIL || !CF_API_TOKEN) {
  console.error(`
Missing Confluence credentials. Set these in server/.env:

  CF_BASE_URL=https://yourcompany.atlassian.net
  CF_EMAIL=yourname@company.com
  CF_API_TOKEN=your-atlassian-api-token
  CF_SPACE_NAMES=Engineering,HR Policies

Get your API token at: https://id.atlassian.com/manage-profile/security/api-tokens
`);
  process.exit(1);
}

if (CF_SPACE_NAMES.length === 0) {
  console.error('CF_SPACE_NAMES is required — e.g. CF_SPACE_NAMES=Engineering,HR Policies');
  process.exit(1);
}

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global` +
  `/collections/default_collection/engines/${dest.engine}` +
  `/assistants/${dest.assistant}/agents`;

console.log(`Project : ${GCP_PROJECT}`);
console.log(`Engine  : ${dest.engine}`);
console.log(`Spaces  : ${CF_SPACE_NAMES.join(', ')}`);
console.log('');

// ── STEP 1: Crawl Confluence → data store ────────────────────────────────────
console.log('═══ STEP 1: Crawl Confluence + create data store ═══');
const creds: ConfluenceCreds = {
  base_url:   CF_BASE_URL,
  email:      CF_EMAIL,
  api_token:  CF_API_TOKEN,
  spaceNames: CF_SPACE_NAMES,
};

const agentSourceId = `test-path-a-${Date.now()}`;
const cfResult = await migrateConfluenceToDataStore(
  GCP_PROJECT,
  saToken,
  agentSourceId,
  creds,
);

console.log(`Pages crawled : ${cfResult.pageCount}`);
console.log(`Spaces found  : ${cfResult.spaceCount}`);
if (cfResult.error)       console.log(`Warning       : ${cfResult.error}`);
if (cfResult.dataStoreId) console.log(`Data store ID : ${cfResult.dataStoreId}`);
if (cfResult.resourcePath) console.log(`Resource path : ${cfResult.resourcePath}`);

if (!cfResult.dataStoreId || cfResult.pageCount === 0) {
  console.error('\n❌ Crawl failed or no pages found. Cannot create agent without data.');
  if (cfResult.error) console.error(`   Reason: ${cfResult.error}`);
  process.exit(1);
}

console.log('\n✅ Data store ready.');

// ── STEP 2: Create agent with dataStoreSpecs ─────────────────────────────────
console.log('\n═══ STEP 2: Create agent with dataStoreSpecs ═══');
const dsResourcePath = cfResult.resourcePath ??
  `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/${cfResult.dataStoreId}`;

const spaceLabel = CF_SPACE_NAMES.join(', ');
const rootNode = {
  id: 'root_agent',
  displayName: `Confluence Agent — ${spaceLabel}`,
  llmAgentNode: {
    description: `Answers questions from Confluence spaces: ${spaceLabel}.`,
    model: 'gemini-2.5-flash',
    instruction:
      `You are a helpful assistant grounded in your company's Confluence knowledge base. ` +
      `Use the connected knowledge source to answer questions accurately. ` +
      `Always cite the Confluence page title when answering. ` +
      `If the answer is not in the knowledge base, say so clearly.`,
    subAgentIds: [],
    selectedTools: { tool: [{ name: 'googleSearch' }] },
    dataStoreSpecs: {
      specs: [{ dataStore: dsResourcePath }],
    },
  },
};

const agentBody = {
  displayName: `Confluence Agent — ${spaceLabel}`,
  description: `Grounded on Confluence spaces: ${spaceLabel}. Created by Path A migration.`,
  starterPrompts: [
    { text: 'What is the sick leave policy?' },
    { text: 'Summarize the engineering handbook.' },
    { text: 'What tools do we use for project management?' },
  ],
  icon: {},
  lowCodeAgentDefinition: {
    rootAgentId: 'root_agent',
    nodes: [rootNode],
    deployedNodes: [rootNode],
    deployedRootAgentId: 'root_agent',
    draftDisplayName: `Confluence Agent — ${spaceLabel}`,
    draftDescription: `Grounded on Confluence spaces: ${spaceLabel}.`,
    draftStarterPrompts: [
      { text: 'What is the sick leave policy?' },
      { text: 'Summarize the engineering handbook.' },
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
  console.error(`❌ Agent creation failed: ${createT.slice(0, 400)}`);
  process.exit(1);
}

const created = JSON.parse(createT) as Record<string, unknown>;
const agentId = String(created['name']).split('/').pop()!;
console.log(`✅ Agent created: id=${agentId}  state=${created['state']}`);

// ── STEP 3: Summary ──────────────────────────────────────────────────────────
console.log(`
════════════════════════════════════════
  PATH A END-TO-END RESULT
════════════════════════════════════════
  Confluence pages : ${cfResult.pageCount} from ${cfResult.spaceCount} space(s)
  Data store ID    : ${cfResult.dataStoreId}
  Agent ID         : ${agentId}
  Agent state      : ${created['state']}

  ✅ Data store CREATED and CONNECTED to agent via dataStoreSpecs.

  NEXT — make the agent gallery-visible:
  1. Go to business.gemini.google
  2. Open Agents gallery
  3. Find "${`Confluence Agent — ${spaceLabel}`}"
  4. Click Publish (one-time admin action — cannot be automated via API)
  5. Test: ask "What is the sick leave policy?" or any Confluence question

  NOTE: Agents start PRIVATE (API limitation — :publish via DWD token does not
  change state; only a real OAuth user click in the console does).
════════════════════════════════════════
`);
