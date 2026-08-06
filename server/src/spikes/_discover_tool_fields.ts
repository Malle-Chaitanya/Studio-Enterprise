/**
 * Discover valid tool field names for agent selectedTools.
 * The UI shows "connectors" — we need the correct proto field name.
 * Also tries to list tools/toolsets via API.
 *
 * Run: cd server && npx tsx src/spikes/_discover_tool_fields.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const CF_DS = `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/confluence-knowledge-agent-all`;

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

// Try to list tools via different paths
const toolPaths = [
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/tools`,
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/tools`,
  `${HOST}/projects/${dest.project}/locations/global/tools`,
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/dataStores/${dest.assistant}/tools`,
];

console.log('─── Tool listing paths ───');
for (const p of toolPaths) {
  const r = await fetch(p, { headers: { Authorization: `Bearer ${saToken}` } });
  const t = await r.text();
  const suffix = p.split('/').slice(-3).join('/');
  console.log(`GET .../${suffix}: ${r.status}`);
  if (r.ok && r.status !== 404) console.log(`  ${t.slice(0, 500)}`);
}

// Try different tool field names in a test agent creation
const toolFieldsToTry = [
  { fieldName: 'dataStoreTool', value: { dataStoreId: CF_DS } },
  { fieldName: 'dataStoreTool', value: { dataStores: [CF_DS] } },
  { fieldName: 'searchTool', value: { dataStoreId: CF_DS } },
  { fieldName: 'vertexAiSearchTool', value: { dataStoreId: CF_DS } },
  { fieldName: 'enterpriseSearchTool', value: { dataStoreId: CF_DS } },
  { fieldName: 'grounding', value: { dataStoreId: CF_DS } },
  { fieldName: 'retrievalTool', value: { dataStoreId: CF_DS } },
  { fieldName: 'knowledgeTool', value: { dataStoreId: CF_DS } },
  { fieldName: 'dataStore', value: CF_DS },           // just the string
  { fieldName: 'name', value: CF_DS },                // by full resource name
  { fieldName: 'toolResourceName', value: CF_DS },
];

console.log('\n─── Tool field name probing ───');
for (const { fieldName, value } of toolFieldsToTry) {
  const body = {
    displayName: `Tool probe (${fieldName})`,
    description: 'Probe only',
    lowCodeAgentDefinition: {
      rootAgentId: 'root',
      nodes: [{
        id: 'root', displayName: 'Root',
        llmAgentNode: {
          model: 'gemini-2.5-flash',
          instruction: 'Test',
          subAgentIds: [],
          selectedTools: { tool: [{ [fieldName]: value }] },
        },
      }],
    },
  };
  const r = await fetch(agentBase, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (r.ok) {
    const j = JSON.parse(t) as Record<string, unknown>;
    const id = String(j['name']).split('/').pop();
    console.log(`✅ "${fieldName}": ACCEPTED! state=${j['state']}, id=${id}`);
    // Delete immediately
    await fetch(`${agentBase}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
    console.log(`   (deleted)`);
    await new Promise(r => setTimeout(r, 1000));
  } else {
    const msg = (() => { try { return (JSON.parse(t) as { error: { message: string } }).error.message; } catch { return t; } })();
    const isUnknown = msg.includes('Unknown name');
    console.log(`${isUnknown ? '❌' : '⚠️'} "${fieldName}": ${r.status} — ${msg.slice(0, 120)}`);
  }
  await new Promise(r => setTimeout(r, 500));
}

// Also try creating an agent WITHOUT selectedTools (just the data store in description)
console.log('\n─── Empty tool (no selectedTools) ───');
const body0 = {
  displayName: 'No-tool probe',
  description: CF_DS, // put DS in description as a test
  lowCodeAgentDefinition: {
    rootAgentId: 'root',
    nodes: [{
      id: 'root', displayName: 'Root',
      llmAgentNode: {
        model: 'gemini-2.5-flash',
        instruction: 'You are a helpful assistant.',
        subAgentIds: [],
        selectedTools: {},   // empty
      },
    }],
  },
};
const r0 = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body0),
});
const t0 = await r0.text();
if (r0.ok) {
  const j0 = JSON.parse(t0) as Record<string, unknown>;
  const id0 = String(j0['name']).split('/').pop();
  console.log(`No-tool agent: ${r0.status}, state=${j0['state']}, id=${id0}`);
  // Try calling publish on this — test if ENABLED comes from the tool presence
  const pr = await fetch(`${agentBase}/${id0}:publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log(`  :publish: ${pr.status}`);
  await new Promise(r => setTimeout(r, 2000));
  const gr = await fetch(`${agentBase}/${id0}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const gj = await gr.json() as Record<string, unknown>;
  console.log(`  state after publish: ${gj['state']}`);
  await fetch(`${agentBase}/${id0}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
} else {
  console.log(`No-tool agent: ${r0.status} — ${t0.slice(0, 200)}`);
}
