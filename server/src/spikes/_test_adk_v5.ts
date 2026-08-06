/**
 * ADK Confluence agent v5 — fix: use AdkApp wrapper.
 *
 * v4 failure: Agentspace calls RE with default method `query`.
 * Raw ADK Agent doesn't expose `query` — only session methods.
 * Fix: wrap Agent with AdkApp, which adds the `query` class method.
 *
 * Data already indexed. No re-import.
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_v5.ts
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

const AGENT_NAME = 'Confluence Knowledge Agent';
const AGENT_DESC = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR)';

// v4 RE + agent to delete
const OLD_RE       = 'projects/231705905417/locations/us-central1/reasoningEngines/6740183849394765824';
const OLD_AGENT_ID = '15856805894019110770';

const DS_PATH = dataStoreResourcePath(SA_PROJECT, 'cf-knowledge-eng-hr');

console.log('=== ADK Confluence Agent v5 (AdkApp wrapper) ===\n');

const saTokenOwn = await getSaToken();
const saToken    = await getSaToken(GEMINI_ADMIN);
const dest       = await resolveDestination(GCP_PROJECT, saToken);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

// ── Delete old v4 ─────────────────────────────────────────────────────────────
console.log('[0/3] Deleting v4 agent + RE...');
const delAgent = await fetch(`${base}/agents/${OLD_AGENT_ID}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` },
});
console.log(`  Delete v4 agent: ${delAgent.status} ${delAgent.ok ? '✓' : '(gone?)'}`);
const delRe = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${OLD_RE}`,
  { method: 'DELETE', headers: { Authorization: `Bearer ${saTokenOwn}` } },
);
const delReText = await delRe.text();
console.log(`  Delete v4 RE: ${delRe.status} ${delRe.ok ? '✓' : delReText.slice(0, 100)}`);

// ── Deploy RE with AdkApp wrapper ─────────────────────────────────────────────
console.log('\n[1/3] Deploying RE with AdkApp wrapper (2-5 min)...');
const spec = {
  name: 'confluence_knowledge_v5',
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
  groundingDataStores: [DS_PATH],
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

// ── Register + share ──────────────────────────────────────────────────────────
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
console.log('\nTest: business.gemini.google → "What is the leave policy?"');
