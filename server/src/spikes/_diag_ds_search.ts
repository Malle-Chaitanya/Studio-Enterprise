/**
 * Test data store search directly + check IAM for Gemini grounding access.
 *
 * RE returns retrieval_queries but retrieval_metadata:{} → 0 results.
 * This means Gemini searched but found nothing (or access failed silently).
 *
 * Test: search via engine serving config → verify 10 docs are indexed.
 * Then grant correct Vertex AI service agent discoveryengine.viewer.
 *
 * Usage: cd server && npx tsx src/spikes/_diag_ds_search.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT  = 'studio-enterprise-migration';
const SA_PROJ_NUM = '231705905417';
const DATA_STORE  = 'cf-knowledge-eng-hr';
const ENGINE      = 'cf-knowledge-search';

const tok = await getSaToken();

// ── 1. Search via engine serving config ───────────────────────────────────────
console.log('=== 1. Search via engine serving config ===');
const searchRes = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/servingConfigs/default_search:search`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'leave policy', pageSize: 5 }),
  },
);
const searchJson = await searchRes.json() as Record<string, unknown>;
console.log(`Status: ${searchRes.status}`);
const results = (searchJson['results'] as Array<Record<string, unknown>>) ?? [];
console.log(`Results: ${results.length}`);
for (const r of results) {
  const doc = r['document'] as Record<string, unknown> | undefined;
  const structs = doc?.['structData'] as Record<string, unknown> | undefined;
  const title = structs?.['title'] ?? doc?.['id'];
  console.log(`  - ${title}`);
}
if (results.length === 0) {
  console.log(`Full response: ${JSON.stringify(searchJson).slice(0, 500)}`);
}

// ── 2. Count documents in data store ─────────────────────────────────────────
console.log('\n=== 2. Document count in data store ===');
const docRes = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE}/branches/default_branch/documents?pageSize=5`,
  { headers: { Authorization: `Bearer ${tok}` } },
);
const docJson = await docRes.json() as Record<string, unknown>;
const docs = (docJson['documents'] as unknown[]) ?? [];
console.log(`Status: ${docRes.status}, documents: ${docs.length} (first page)`);
const total = docJson['totalSize'] ?? '?';
console.log(`totalSize: ${total}`);

// ── 3. Check IAM for Vertex AI service agents on our project ─────────────────
console.log('\n=== 3. Current discoveryengine.viewer grants ===');
const iamRes = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:getIamPolicy`,
  { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: '{}' },
);
const iamJson = await iamRes.json() as { bindings?: { role: string; members: string[] }[] };
for (const b of iamJson.bindings ?? []) {
  if (b.role.includes('discoveryengine') || b.role.includes('aiplatform')) {
    console.log(`  ${b.role}: ${b.members.join(', ')}`);
  }
}

// ── 4. Grant Vertex AI service agent discoveryengine.viewer ───────────────────
// When Gemini's generateContent processes vertex_ai_search.datastore,
// it uses the Vertex AI service agent (gcp-sa-aiplatform) of the CALLING project
// to search the data store. Grant discoveryengine.viewer to this agent.
console.log('\n=== 4. Grant Vertex AI service agent discoveryengine.viewer ===');
const aiplatformAgent = `service-${SA_PROJ_NUM}@gcp-sa-aiplatform.iam.gserviceaccount.com`;
const role = 'roles/discoveryengine.viewer';
const member = `serviceAccount:${aiplatformAgent}`;

const policy = iamJson;
policy.bindings = policy.bindings ?? [];
const binding = policy.bindings.find(b => b.role === role);
if (binding?.members.includes(member)) {
  console.log(`Already granted: ${aiplatformAgent}`);
} else {
  if (binding) binding.members.push(member);
  else policy.bindings.push({ role, members: [member] });
  const setRes = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:setIamPolicy`,
    { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) },
  );
  console.log(`setIamPolicy: ${setRes.status} ${setRes.ok ? `✓ granted ${aiplatformAgent}` : (await setRes.text()).slice(0, 200)}`);
}

// ── 5. Try data store search via default_serving_config path ─────────────────
console.log('\n=== 5. Try data store servingConfigs/default_serving_config ===');
const dscSearch = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE}/servingConfigs/default_serving_config:search`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'leave policy', pageSize: 3 }),
  },
);
const dscText = await dscSearch.text();
console.log(`default_serving_config:search — ${dscSearch.status}: ${dscText.slice(0, 300)}`);
