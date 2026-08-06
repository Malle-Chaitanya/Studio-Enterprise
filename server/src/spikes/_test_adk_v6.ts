/**
 * ADK Confluence agent v6 — fix: AgentspaceAdkApp with query→stream_query alias.
 *
 * v5 failure: Agentspace sends class_method='query'. AdkApp only exposes stream_query.
 * Fix: AgentspaceAdkApp subclasses AdkApp and adds query() = stream_query().
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_v6.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const SA_PROJECT   = 'studio-enterprise-migration';
const GCP_LOCATION = 'us-central1';
const GCS_BUCKET   = `${SA_PROJECT}-adk-staging`;
const AGENT_NAME   = 'Confluence Knowledge Agent';
const AGENT_DESC   = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR)';

const OLD_RE       = 'projects/231705905417/locations/us-central1/reasoningEngines/6618586659455762432';
const OLD_AGENT_ID = '4003993719884630290';
const DS_PATH      = dataStoreResourcePath(SA_PROJECT, 'cf-knowledge-eng-hr');

console.log('=== ADK Confluence Agent v6 (query alias) ===\n');

const saTokenOwn = await getSaToken();
const saToken    = await getSaToken(GEMINI_ADMIN);
const dest       = await resolveDestination(GCP_PROJECT, saToken);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

console.log('[0/3] Deleting v5...');
try {
  const dr = await fetch(`${base}/agents/${OLD_AGENT_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`  agent: ${dr.status}`);
} catch (e) { console.log(`  agent delete skipped: ${e}`); }
try {
  const rr = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${OLD_RE}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saTokenOwn}` } });
  const rt = await rr.text();
  console.log(`  RE: ${rt.slice(0, 80)}`);
} catch (e) { console.log(`  RE delete skipped: ${e}`); }

console.log('\n[1/3] Deploying RE with AgentspaceAdkApp (query alias)...');
const dep = await deployReasoningEngine(SA_PROJECT, GCP_LOCATION, {
  name: 'confluence_knowledge_v6',
  displayName: AGENT_NAME,
  description: AGENT_DESC,
  model: 'gemini-2.5-flash',
  instruction: `You are ${AGENT_NAME}, an AI assistant for CloudFuze. Answer questions using the Confluence knowledge base (Engineering and HR pages). Always cite the page title when referencing specific information. If the answer is not in the knowledge base, say so clearly.`,
  tools: [],
  groundingDataStores: [DS_PATH],
}, {
  scriptPath: 'scripts/adk_deploy.py',
  stagingBucket: `gs://${GCS_BUCKET}`,
  timeoutMs: 15 * 60 * 1000,
});
if (!dep.ok || !dep.reasoningEngine) { console.error(`Deploy failed: ${dep.error}`); process.exit(1); }
console.log(`  RE: ${dep.reasoningEngine} ✓`);

console.log('\n[2/3] Registering + sharing...');
const reg = await registerAdkAgent(dest, saToken, { reasoningEngine: dep.reasoningEngine, displayName: AGENT_NAME, description: AGENT_DESC });
if (!reg.registered) { console.error(`Register failed: ${reg.error}`); process.exit(1); }
console.log(`  Agent ID: ${reg.agentId}, State: ${reg.state}`);

await fetch(`${base}/agents/${reg.agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
}).then(r => console.log(`  Share: ${r.status} ${r.ok ? '✓' : ''}`));

// Verify query method works
console.log('\n[3/3] Verifying query method...');
await new Promise(r => setTimeout(r, 30000)); // wait for RE to start
const reId = dep.reasoningEngine.split('/').pop();
const rePath = `projects/231705905417/locations/us-central1/reasoningEngines/${reId}`;
const testR = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${rePath}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const testT = await testR.text();
console.log(`  query test: ${testR.status}`);
try {
  const j = JSON.parse(testT) as Record<string, unknown>;
  const text = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
  console.log(`  Answer: ${text.slice(0, 200) || JSON.stringify(j).slice(0, 200)}`);
} catch { console.log(`  Raw: ${testT.slice(0, 300)}`); }

console.log('\n=== DONE ===');
console.log(`Agent ID: ${reg.agentId}`);
console.log(`RE: ${dep.reasoningEngine}`);
console.log('\nTest: business.gemini.google → "What is the leave policy?"');
