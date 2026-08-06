/**
 * Same-project test: RE + data store both in studio-enterprise-migration.
 * No cross-project IAM needed. Proves grounding works before worrying about
 * Agentspace registration in a separate customer project.
 *
 * Usage: cd server && npx tsx src/spikes/_test_same_project.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { deployReasoningEngine } from '../services/adkDeployer.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';

const SA_PROJECT   = 'studio-enterprise-migration';
const SA_PROJ_NUM  = '231705905417';
const GCP_LOCATION = 'us-central1';
const GCS_BUCKET   = `${SA_PROJECT}-adk-staging`;
const DS_PATH      = dataStoreResourcePath(SA_PROJECT, 'cf-knowledge-eng-hr');

console.log('=== Same-Project Test (studio-enterprise-migration) ===\n');
console.log('Data store:', DS_PATH);
console.log('');

const tok = await getSaToken();

// 1. Discover Agentspace in studio-enterprise-migration
console.log('[0] Discover Agentspace in studio-enterprise-migration...');
const deHost = 'https://discoveryengine.googleapis.com/v1alpha';
const deBase = `${deHost}/projects/${SA_PROJ_NUM}/locations/global`;
const engR = await fetch(`${deBase}/collections/default_collection/engines`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const engJ = await engR.json() as Record<string, unknown>;
console.log(`  engines: ${JSON.stringify(engJ).slice(0, 300)}`);

// 2. Deploy RE in studio-enterprise-migration (same project as data store)
console.log('\n[1] Deploying RE (same-project)...');
const dep = await deployReasoningEngine(SA_PROJECT, GCP_LOCATION, {
  name: 'cf_knowledge_same_project',
  displayName: 'Confluence Knowledge - Same Project Test',
  description: 'Same-project test: RE + data store in studio-enterprise-migration',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant. Answer questions using the Confluence knowledge base. Cite the page title when referencing specific information.',
  tools: [],
  groundingDataStores: [DS_PATH],
}, {
  scriptPath: 'scripts/adk_deploy.py',
  stagingBucket: `gs://${GCS_BUCKET}`,
  timeoutMs: 15 * 60 * 1000,
});
if (!dep.ok || !dep.reasoningEngine) { console.error(`Deploy failed: ${dep.error}`); process.exit(1); }
console.log(`  RE: ${dep.reasoningEngine} ✓`);
const rePath = dep.reasoningEngine;

// 3. Check classMethods
console.log('\n[2] Checking RE classMethods...');
await new Promise(r => setTimeout(r, 5000));
const metaR = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${rePath}`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const meta = await metaR.json() as Record<string, unknown>;
console.log('  classMethods:', JSON.stringify(meta['classMethods']));

// 4. Test stream_query (baseline)
console.log('\n[3] Test stream_query (baseline)...');
await new Promise(r => setTimeout(r, 60000)); // wait for container
const r1 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${rePath}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const t1 = await r1.text();
console.log(`  stream_query status: ${r1.status}`);
try {
  const j = JSON.parse(t1) as Record<string, unknown>;
  const text = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
  console.log(`  Answer: ${text.slice(0, 300) || JSON.stringify(j).slice(0, 200)}`);
} catch { console.log(`  Raw: ${t1.slice(0, 400)}`); }

// 5. Test query (the Agentspace method)
console.log('\n[4] Test query (Agentspace method)...');
const r2 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${rePath}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const t2 = await r2.text();
console.log(`  query status: ${r2.status}`);
try {
  const lines = t2.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const j = JSON.parse(line) as Record<string, unknown>;
    const content = j['content'] as Record<string, unknown> | undefined;
    const text = (content?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
    if (text) { console.log(`  Answer: ${text.slice(0, 400)}`); break; }
  }
  if (!t2.includes('"text"')) console.log(`  Raw: ${t2.slice(0, 400)}`);
} catch { console.log(`  Raw: ${t2.slice(0, 400)}`); }

// 6. Try registering in studio-enterprise-migration Agentspace (if it exists)
console.log('\n[5] Trying to register agent in studio-enterprise-migration Agentspace...');
const assistR = await fetch(`${deBase}/collections/default_collection/engines`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const assistJ = await assistR.json() as { engines?: Array<Record<string, unknown>> };
const firstEngine = (assistJ.engines ?? [])[0];
if (firstEngine) {
  const engineId = String(firstEngine['name']).split('/').pop();
  console.log(`  Found engine: ${engineId}`);
  // Try to list/create assistants
  const astR = await fetch(`${deBase}/collections/default_collection/engines/${engineId}/assistants`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const astJ = await astR.json() as Record<string, unknown>;
  console.log(`  assistants: ${JSON.stringify(astJ).slice(0, 300)}`);
} else {
  console.log('  No Agentspace engine found — testing RE directly only.');
}

console.log('\n=== DONE ===');
console.log(`RE: ${rePath}`);
console.log('\nSame-project grounding test complete.');
