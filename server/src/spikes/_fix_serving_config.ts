/**
 * Fix: data store cf-knowledge-eng-hr has no serving config.
 * VertexAiSearchTool needs default_serving_config to query the data store.
 * Fix: create a search engine on top of the data store → engine auto-creates serving configs.
 *
 * Usage: cd server && npx tsx src/spikes/_fix_serving_config.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT  = 'studio-enterprise-migration';
const SA_PROJ_NUM = '231705905417';
const DATA_STORE  = 'cf-knowledge-eng-hr';
const ENGINE_ID   = 'cf-knowledge-search';

const tok = await getSaToken();

// ── 1. Check if default_serving_config already exists ────────────────────────
console.log('=== 1. Check default_serving_config directly ===');
const scDirect = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE}/servingConfigs/default_serving_config`,
  { headers: { Authorization: `Bearer ${tok}` } },
);
console.log(`default_serving_config: ${scDirect.status}`);
if (scDirect.ok) {
  const sc = await scDirect.json() as Record<string, unknown>;
  console.log('ALREADY EXISTS:', JSON.stringify(sc).slice(0, 300));
} else {
  console.log('Not found, need to create engine.');
}

// ── 2. List existing engines ──────────────────────────────────────────────────
console.log('\n=== 2. List existing engines ===');
const engList = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/engines`,
  { headers: { Authorization: `Bearer ${tok}` } },
);
console.log(`engines status: ${engList.status}`);
const engJson = await engList.json() as { engines?: Array<Record<string, unknown>> };
const engines = engJson.engines ?? [];
console.log(`Found ${engines.length} engines:`);
for (const e of engines) {
  console.log(`  ${e['name']} — ${e['displayName']} — ds: ${JSON.stringify(e['dataStoreIds'])}`);
}

// ── 3. Create search engine if none points to our data store ─────────────────
const hasEngine = engines.some(e => {
  const ids = e['dataStoreIds'] as string[] | undefined;
  return ids?.includes(DATA_STORE);
});

if (!hasEngine) {
  console.log(`\n=== 3. Create search engine "${ENGINE_ID}" → ${DATA_STORE} ===`);
  const body = {
    displayName: 'CF Knowledge Search',
    solutionType: 'SOLUTION_TYPE_SEARCH',
    dataStoreIds: [DATA_STORE],
    searchEngineConfig: { searchTier: 'SEARCH_TIER_STANDARD' },
  };
  const createRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/engines?engineId=${ENGINE_ID}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const createText = await createRes.text();
  console.log(`Create engine: ${createRes.status}: ${createText.slice(0, 400)}`);

  if (!createRes.ok && !createText.includes('ALREADY_EXISTS')) {
    console.error('Engine creation failed. Exiting.');
    process.exit(1);
  }

  // Poll engine state
  console.log('Polling engine state (create takes ~30s)...');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const getRes = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/engines/${ENGINE_ID}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    const getJson = await getRes.json() as Record<string, unknown>;
    const state = (getJson['servingState'] ?? getJson['state'] ?? 'unknown') as string;
    console.log(`  [${i + 1}] state: ${state}`);
    if (state === 'ACTIVE' || state === 'SERVING') break;
  }
} else {
  console.log('\n=== 3. Engine already exists for this data store — skip create ===');
}

// ── 4. List engine serving configs ───────────────────────────────────────────
console.log(`\n=== 4. Engine serving configs ===`);
const scRes = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/engines/${ENGINE_ID}/servingConfigs`,
  { headers: { Authorization: `Bearer ${tok}` } },
);
console.log(`engine servingConfigs: ${scRes.status}`);
const scJson = await scRes.json() as Record<string, unknown>;
console.log(JSON.stringify(scJson, null, 2).slice(0, 600));

// ── 5. Also check engine default_serving_config ───────────────────────────────
console.log(`\n=== 5. Engine default_serving_config ===`);
const dscRes = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/engines/${ENGINE_ID}/servingConfigs/default_config`,
  { headers: { Authorization: `Bearer ${tok}` } },
);
console.log(`default_config: ${dscRes.status}: ${(await dscRes.text()).slice(0, 300)}`);

console.log(`\n=== SUMMARY ===`);
console.log(`Engine path: projects/${SA_PROJ_NUM}/locations/global/collections/default_collection/engines/${ENGINE_ID}`);
console.log(`DataStore path: projects/${SA_PROJ_NUM}/locations/global/collections/default_collection/dataStores/${DATA_STORE}`);
console.log('\nNext: update adk_deploy.py to use engine path, redeploy RE');
