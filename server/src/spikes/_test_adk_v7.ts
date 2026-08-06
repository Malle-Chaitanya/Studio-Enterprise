/**
 * ADK Confluence agent v7 — module-level AgentspaceAdkApp fix.
 *
 * Root cause of v6 failure: AgentspaceAdkApp defined inside main() can't be
 * reliably deserialized by cloudpickle in the RE container → falls back to
 * AdkApp → no query method.
 * Fix: AgentspaceAdkApp defined at MODULE LEVEL in adk_deploy.py.
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_v7.ts
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

const OLD_RE       = 'projects/231705905417/locations/us-central1/reasoningEngines/478491517489512448';
const OLD_AGENT_ID = '10469807853687050541';
const DS_PATH      = dataStoreResourcePath(SA_PROJECT, 'cf-knowledge-eng-hr');

console.log('=== ADK Confluence Agent v7 (module-level query fix) ===\n');

const saTokenOwn = await getSaToken();
const saToken    = await getSaToken(GEMINI_ADMIN);
const dest       = await resolveDestination(GCP_PROJECT, saToken);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

console.log('[0/4] Cleanup v6...');
try {
  const dr = await fetch(`${base}/agents/${OLD_AGENT_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`  agent: ${dr.status}`);
} catch (e) { console.log(`  agent delete skipped: ${e}`); }
try {
  const rr = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${OLD_RE}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saTokenOwn}` } });
  const rt = await rr.text();
  console.log(`  RE: ${rt.slice(0, 80)}`);
} catch (e) { console.log(`  RE delete skipped: ${e}`); }

console.log('\n[1/4] Deploying RE v7 (module-level AgentspaceAdkApp)...');
const dep = await deployReasoningEngine(SA_PROJECT, GCP_LOCATION, {
  name: 'confluence_knowledge_v7',
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
const reId = dep.reasoningEngine.split('/').pop();
console.log(`  RE: ${dep.reasoningEngine} ✓`);

// Check classMethods registered on the RE
console.log('\n[2/4] Checking RE classMethods...');
await new Promise(r => setTimeout(r, 5000));
const metaR = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${dep.reasoningEngine}`, {
  headers: { Authorization: `Bearer ${saTokenOwn}` },
});
const meta = await metaR.json() as Record<string, unknown>;
console.log('  classMethods:', JSON.stringify(meta['classMethods']));
// query should now appear

console.log('\n[3/4] Registering + sharing...');
const reg = await registerAdkAgent(dest, saToken, { reasoningEngine: dep.reasoningEngine, displayName: AGENT_NAME, description: AGENT_DESC });
if (!reg.registered) { console.error(`Register failed: ${reg.error}`); process.exit(1); }
console.log(`  Agent ID: ${reg.agentId}, State: ${reg.state}`);

await fetch(`${base}/agents/${reg.agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
}).then(r => console.log(`  Share: ${r.status} ${r.ok ? '✓' : ''}`));

// Direct query test
console.log('\n[4/4] Testing query method directly...');
await new Promise(r => setTimeout(r, 60000)); // 60s for RE to start
const testR = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${dep.reasoningEngine}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const testT = await testR.text();
console.log(`  query test status: ${testR.status}`);
try {
  const lines = testT.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const j = JSON.parse(line) as Record<string, unknown>;
    const content = j['content'] as Record<string, unknown> | undefined;
    const text = (content?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
    if (text) { console.log(`  Answer: ${text.slice(0, 300)}`); break; }
  }
  if (!testT.includes('"text"')) console.log(`  Raw: ${testT.slice(0, 400)}`);
} catch { console.log(`  Raw: ${testT.slice(0, 400)}`); }

console.log('\n=== DONE ===');
console.log(`Agent ID: ${reg.agentId}`);
console.log(`RE: ${dep.reasoningEngine}`);
console.log('\nTest: business.gemini.google → "What is the leave policy?"');
