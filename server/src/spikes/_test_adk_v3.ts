/**
 * ADK Confluence agent v3 — fix: use engine serving config path instead of bare data store.
 *
 * Root cause of v2 failure:
 *   VertexAiSearchTool(data_store_id=...) internally tries:
 *     {data_store}/servingConfigs/default_serving_config
 *   That path doesn't exist — data store created WITHOUT an engine.
 *   Fix: created search engine "cf-knowledge-search" (via _fix_serving_config.ts).
 *         Engine has serving config "default_search".
 *   Use groundingEngineServingConfigs → VertexAiSearchTool(search_engine_id=...) path.
 *
 * Data (10 Confluence pages) already indexed in cf-knowledge-eng-hr. No re-import needed.
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_v3.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const SA_PROJECT   = 'studio-enterprise-migration';
const SA_PROJ_NUM  = '231705905417';
const GCP_LOCATION = 'us-central1';
const GCS_BUCKET   = `${SA_PROJECT}-adk-staging`;

const AGENT_NAME = 'Confluence Knowledge Agent';
const AGENT_DESC = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR)';

// Old v2 RE + agent to delete
const OLD_RE       = 'projects/231705905417/locations/us-central1/reasoningEngines/3647336805298077696';
const OLD_AGENT_ID = '17306234384094455497';

// Engine serving config created by _fix_serving_config.ts
const ENGINE_SERVING_CONFIG = [
  `projects/${SA_PROJ_NUM}/locations/global/collections/default_collection`,
  `engines/cf-knowledge-search/servingConfigs/default_search`,
].join('/');

console.log('=== ADK Confluence Agent v3 (engine serving config grounding) ===\n');
console.log(`Serving config: ${ENGINE_SERVING_CONFIG}\n`);

const saTokenOwn = await getSaToken();
const saToken    = await getSaToken(GEMINI_ADMIN);
const dest       = await resolveDestination(GCP_PROJECT, saToken);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const assistantBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

// ── Step 0: Delete old RE + agent ─────────────────────────────────────────────
console.log('[0/3] Deleting old v2 RE + agent...');
const delAgent = await fetch(`${assistantBase}/agents/${OLD_AGENT_ID}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` },
});
console.log(`  Delete v2 agent: ${delAgent.status} ${delAgent.ok ? '✓' : '(already gone?)'}`);

const delRe = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${OLD_RE}`,
  { method: 'DELETE', headers: { Authorization: `Bearer ${saTokenOwn}` } },
);
console.log(`  Delete v2 RE:    ${delRe.status} ${delRe.ok ? '✓' : '(already gone?)'}`);
if (!delRe.ok) console.log(`  RE delete detail: ${(await delRe.text()).slice(0, 200)}`);

// ── Step 1: Deploy RE with engine serving config ──────────────────────────────
console.log('\n[1/3] Deploying RE (2-5 min)...');
const spec = {
  name: 'confluence_knowledge_v3',
  displayName: AGENT_NAME,
  description: AGENT_DESC,
  model: 'gemini-2.5-flash',
  instruction: [
    `You are ${AGENT_NAME}, an AI assistant for CloudFuze.`,
    'Answer questions using the Confluence knowledge base (Engineering and HR pages).',
    'Always cite the page title when referencing specific information.',
    'If the answer is not in the knowledge base, say so clearly.',
  ].join(' '),
  tools: [],
  // v3: use engine serving config path → VertexAiSearchTool(search_engine_id=...)
  // This is different from v2 which used groundingDataStores (bare data store, no serving config)
  groundingEngineServingConfigs: [ENGINE_SERVING_CONFIG],
};

const dep = await deployReasoningEngine(SA_PROJECT, GCP_LOCATION, spec, {
  scriptPath: 'scripts/adk_deploy.py',
  stagingBucket: `gs://${GCS_BUCKET}`,
  timeoutMs: 15 * 60 * 1000,
});
if (!dep.ok || !dep.reasoningEngine) {
  console.error(`  Deploy failed: ${dep.error}`);
  process.exit(1);
}
console.log(`  RE: ${dep.reasoningEngine} ✓`);

// ── Step 2: Register agent in mia's Gemini ────────────────────────────────────
console.log('\n[2/3] Registering agent...');
const reg = await registerAdkAgent(dest, saToken, {
  reasoningEngine: dep.reasoningEngine,
  displayName: AGENT_NAME,
  description: AGENT_DESC,
});
if (!reg.registered) {
  console.error(`  Register failed: ${reg.error}`);
  process.exit(1);
}
console.log(`  Agent ID: ${reg.agentId}`);
console.log(`  State:    ${reg.state}`);

// ── Step 3: Share with all users ──────────────────────────────────────────────
console.log('\n[3/3] Sharing with all users...');
const shareRes = await fetch(`${assistantBase}/agents/${reg.agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`  Share ALL_USERS: ${shareRes.status} ${shareRes.ok ? '✓' : await shareRes.text()}`);

console.log('\n=== DONE ===');
console.log(`Agent "${AGENT_NAME}" — state=${reg.state}`);
console.log(`Agent ID: ${reg.agentId}`);
console.log(`RE: ${dep.reasoningEngine}`);
console.log(`Engine serving config: ${ENGINE_SERVING_CONFIG}`);
console.log('\nTest in https://business.gemini.google: ask "What is the leave policy?"');
