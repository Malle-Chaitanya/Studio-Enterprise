/**
 * Explore Agentspace connectors and connector-backed agent creation.
 * Connectors (Confluence, Drive, SharePoint) don't use RE — they use
 * Discovery Engine's native knowledge pipeline, bypassing the query/stream_query issue.
 *
 * Run: cd server && npx tsx src/spikes/_explore_connectors.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const base = `${HOST}/projects/${dest.project}/locations/global`;

console.log(`Engine: ${dest.engine}, Assistant: ${dest.assistant}`);

// ── 1. List data store connectors ─────────────────────────────────────────────
console.log('\n[1] Data store connectors...');
const cr = await fetch(
  `${base}/collections/default_collection/dataStores?pageSize=50`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
const cj = await cr.json() as { dataStores?: Array<{
  name: string; displayName?: string; contentConfig?: string;
  documentProcessingConfig?: Record<string, unknown>;
  workspaceConfig?: { type?: string; dasherCustomerId?: string };
}> };
for (const ds of cj.dataStores ?? []) {
  const id = ds.name.split('/').pop();
  console.log(`  ${id}`);
  console.log(`    displayName: ${ds.displayName}`);
  console.log(`    contentConfig: ${ds.contentConfig}`);
  if (ds.workspaceConfig) console.log(`    workspaceConfig: ${JSON.stringify(ds.workspaceConfig)}`);
}

// ── 2. Try to list "connectors" specifically ─────────────────────────────────
console.log('\n[2] Listing connectors (third-party data sources)...');
// Try various connector API paths
const connPaths = [
  `${base}/collections/default_collection/dataConnectors`,
  `${base}/dataConnectors`,
  `${HOST}/projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataConnectors`,
];
for (const p of connPaths) {
  const r = await fetch(p, { headers: { Authorization: `Bearer ${saToken}` } });
  const t = await r.text();
  console.log(`  GET ${p.split('/').slice(-2).join('/')}: ${r.status}`);
  if (r.ok) {
    try { console.log(`  ${JSON.stringify(JSON.parse(t)).slice(0, 500)}`); } catch { console.log(`  ${t.slice(0, 300)}`); }
  } else {
    console.log(`  ${t.slice(0, 200)}`);
  }
}

// ── 3. List assistants and their tools/knowledge sources ─────────────────────
console.log('\n[3] Assistants and their knowledge sources...');
const ar = await fetch(
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
const aj = await ar.json() as { assistants?: Array<Record<string, unknown>> };
for (const a of aj.assistants ?? []) {
  console.log(`  Assistant: ${String(a['name']).split('/').pop()}`);
  console.log(`  ${JSON.stringify(a, null, 2).slice(0, 1000)}`);
}

// ── 4. Get engine's chat configs / grounding configs ─────────────────────────
console.log('\n[4] Engine serving configs...');
const scr = await fetch(
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/servingConfigs`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
const scj = await scr.json() as { servingConfigs?: Array<Record<string, unknown>> };
console.log(`  serving configs: ${scj.servingConfigs?.length ?? 0}`);
for (const sc of scj.servingConfigs ?? []) {
  console.log(`  ${JSON.stringify(sc).slice(0, 500)}`);
}

// ── 5. Check for workspace integrations ──────────────────────────────────────
console.log('\n[5] Workspace data stores (Google/Microsoft integrations)...');
const wsr = await fetch(
  `${base}/collections/default_collection/dataStores?filter=workspaceConfig.type!=UNKNOWN`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
const wsj = await wsr.json() as { dataStores?: Array<Record<string, unknown>> };
if (wsj.dataStores?.length) {
  for (const ds of wsj.dataStores) {
    console.log(`  ${JSON.stringify(ds).slice(0, 300)}`);
  }
} else {
  console.log('  No workspace data stores found (or filter unsupported)');
}

// ── 6. Try creating a connector-backed agent ─────────────────────────────────
console.log('\n[6] Attempt: create agent with toolsets/connectors...');
const confluenceDataStores = (cj.dataStores ?? []).filter(ds =>
  (ds.displayName ?? '').toLowerCase().includes('confluence') ||
  (ds.name ?? '').toLowerCase().includes('confluence')
);
console.log(`  Confluence data stores: ${confluenceDataStores.length}`);
if (confluenceDataStores.length > 0) {
  const cfDs = confluenceDataStores[0];
  const cfId = cfDs.name; // full resource name
  console.log(`  Using: ${cfId}`);

  // Try: low-code agent with data store tool
  const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

  // Format 1: tool with dataStoreSpec
  const body1 = {
    displayName: 'Confluence Connector Test v1',
    description: 'Testing connector-backed agent creation',
    lowCodeAgentDefinition: {
      rootAgentId: 'root',
      nodes: [{
        id: 'root',
        displayName: 'Root',
        llmAgentNode: {
          model: 'gemini-2.5-flash',
          instruction: 'You are a helpful assistant grounded on Confluence knowledge. Answer questions from the knowledge base.',
          subAgentIds: [],
          selectedTools: {
            tool: [{
              // Try dataStoreSpec
              dataStoreSpec: { dataStores: [cfId] }
            }]
          },
        },
      }],
    },
  };

  const r1 = await fetch(agentBase, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body1),
  });
  const t1 = await r1.text();
  console.log(`  Format 1 (dataStoreSpec): ${r1.status}`);
  if (r1.ok) {
    const j1 = JSON.parse(t1) as Record<string, unknown>;
    console.log(`  state: ${j1['state']}, id: ${String(j1['name']).split('/').pop()}`);
    // Clean up immediately
    const id1 = String(j1['name']).split('/').pop();
    await fetch(`${agentBase}/${id1}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
    console.log(`  (deleted test agent)`);
  } else {
    console.log(`  ${t1.slice(0, 300)}`);

    // Format 2: toolset reference
    const body2 = {
      displayName: 'Confluence Connector Test v2',
      description: 'Testing connector-backed agent',
      lowCodeAgentDefinition: {
        rootAgentId: 'root',
        nodes: [{
          id: 'root',
          displayName: 'Root',
          llmAgentNode: {
            model: 'gemini-2.5-flash',
            instruction: 'You are a helpful assistant.',
            subAgentIds: [],
            selectedTools: {
              tool: [{
                knowledgeConnectorTool: { dataStoreId: cfId }
              }]
            },
          },
        }],
      },
    };
    const r2 = await fetch(agentBase, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body2),
    });
    const t2 = await r2.text();
    console.log(`  Format 2 (knowledgeConnectorTool): ${r2.status}`);
    console.log(`  ${t2.slice(0, 400)}`);
    if (r2.ok) {
      const j2 = JSON.parse(t2) as Record<string, unknown>;
      const id2 = String(j2['name']).split('/').pop();
      await fetch(`${agentBase}/${id2}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
    }
  }
} else {
  console.log('  No Confluence data store found — cannot test connector-backed agent');
}

console.log('\nDone. Check output above for connector paths and available data stores.');
