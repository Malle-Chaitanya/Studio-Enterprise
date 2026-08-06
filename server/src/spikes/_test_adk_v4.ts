/**
 * ADK Confluence agent v4 — fix: back to data_store_id (not search_engine_id).
 *
 * v3 failure: search_engine_id was passed as serving config path
 *   → Gemini sees vertex_ai_search.engine = ".../servingConfigs/default_search"
 *   → Gemini rejects: "Invalid Vertex AI engine resource name"
 *   (The field expects just the ENGINE path, not the serving config path)
 *
 * v4 fix: use data_store_id → Gemini sees vertex_ai_search.datastore field.
 *   The datastore field does NOT require a serving config.
 *   The RE service agent already has discoveryengine.viewer on studio-enterprise-migration.
 *   The data store is in the SAME project as the RE → access works.
 *
 * Data (10 Confluence pages) already indexed. Skip re-import.
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_v4.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const SA_PROJECT   = 'studio-enterprise-migration';
const SA_PROJ_NUM  = '231705905417';
const GCP_LOCATION = 'us-central1';
const GCS_BUCKET   = `${SA_PROJECT}-adk-staging`;
const DATA_STORE_ID = 'cf-knowledge-eng-hr';

const AGENT_NAME = 'Confluence Knowledge Agent';
const AGENT_DESC = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR)';

// v3 RE + agent to delete
const OLD_RE       = 'projects/231705905417/locations/us-central1/reasoningEngines/8180209830246481920';
const OLD_AGENT_ID = '7239752854148799852';

// Data store path → maps to vertex_ai_search.datastore in Gemini (no serving config needed)
const DS_PATH = dataStoreResourcePath(SA_PROJECT, DATA_STORE_ID);

console.log('=== ADK Confluence Agent v4 (data_store_id grounding) ===\n');
console.log(`Data store: ${DS_PATH}\n`);

const saTokenOwn = await getSaToken();
const saToken    = await getSaToken(GEMINI_ADMIN);
const dest       = await resolveDestination(GCP_PROJECT, saToken);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

// ── Step 0: Delete old v3 ─────────────────────────────────────────────────────
console.log('[0/3] Deleting v3 agent + RE...');
const delAgent = await fetch(`${base}/agents/${OLD_AGENT_ID}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` },
});
console.log(`  Delete v3 agent: ${delAgent.status} ${delAgent.ok ? '✓' : '(gone?)'}`);

const delRe = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${OLD_RE}`,
  { method: 'DELETE', headers: { Authorization: `Bearer ${saTokenOwn}` } },
);
console.log(`  Delete v3 RE: ${delRe.status} ${delRe.ok ? '✓' : '(gone?)'}`);

// ── Step 1: Deploy RE with data_store_id ─────────────────────────────────────
console.log('\n[1/3] Deploying RE (2-5 min)...');
const spec = {
  name: 'confluence_knowledge_v4',
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
  // v4: data_store_id → Gemini tool: vertex_ai_search.datastore (no serving config needed)
  groundingDataStores: [DS_PATH],
  // NOT groundingEngineServingConfigs
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

// ── Step 2: Register + share ──────────────────────────────────────────────────
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

console.log('\n[3/3] Sharing with all users...');
const shareRes = await fetch(`${base}/agents/${reg.agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`  Share: ${shareRes.status} ${shareRes.ok ? '✓' : await shareRes.text()}`);

console.log('\n=== DONE ===');
console.log(`Agent "${AGENT_NAME}" state=${reg.state}`);
console.log(`Agent ID: ${reg.agentId}`);
console.log(`RE: ${dep.reasoningEngine}`);
console.log(`\nTest: business.gemini.google → "What is the leave policy?"`);
