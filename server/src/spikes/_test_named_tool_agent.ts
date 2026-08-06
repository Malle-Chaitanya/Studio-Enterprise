/**
 * Create agent with tool.name = Confluence data store resource name.
 * "name" was the only accepted tool field. Test if this provides grounding.
 * Also: inspect the full agent definition to understand what the API accepted.
 *
 * Run: cd server && npx tsx src/spikes/_test_named_tool_agent.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const CF_DS_ID = 'confluence-knowledge-agent-all';
const CF_DS = `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/${CF_DS_ID}`;

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

// Also try tool name as a serving config (what the search endpoint uses)
const CF_SERVING = `${CF_DS}/servingConfigs/default_search`;

// Try creating agent with different "name" values
const testCases = [
  { label: 'DS resource name', toolName: CF_DS },
  { label: 'DS serving config', toolName: CF_SERVING },
  { label: 'DS id only', toolName: CF_DS_ID },
];

for (const tc of testCases) {
  console.log(`\n─── ${tc.label} ───`);
  const body = {
    displayName: `CF Tool Test (${tc.label})`,
    description: 'Tool name test',
    lowCodeAgentDefinition: {
      rootAgentId: 'root',
      nodes: [{
        id: 'root', displayName: 'Root',
        llmAgentNode: {
          model: 'gemini-2.5-flash',
          instruction: 'You are a helpful assistant. Answer questions using the available knowledge sources.',
          subAgentIds: [],
          selectedTools: { tool: [{ name: tc.toolName }] },
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

  if (!r.ok) {
    console.log(`  Create: ${r.status} — ${t.slice(0, 200)}`);
    continue;
  }

  const j = JSON.parse(t) as Record<string, unknown>;
  const agentId = String(j['name']).split('/').pop()!;
  console.log(`  Create: ${r.status}, state=${j['state']}, id=${agentId}`);

  // GET full definition
  const gr = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const gj = await gr.json() as Record<string, unknown>;
  console.log(`  Full definition (selectedTools):`);
  const lcd = gj['lowCodeAgentDefinition'] as Record<string, unknown> | undefined;
  const nodes = lcd?.['nodes'] as Array<Record<string, unknown>> | undefined;
  const node0 = nodes?.[0] as Record<string, unknown> | undefined;
  const llmNode = node0?.['llmAgentNode'] as Record<string, unknown> | undefined;
  const tools = llmNode?.['selectedTools'] as Record<string, unknown> | undefined;
  console.log(`  ${JSON.stringify(tools)}`);

  // Try publish
  const pr = await fetch(`${agentBase}/${agentId}:publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log(`  :publish: ${pr.status}`);
  await new Promise(r => setTimeout(r, 2000));

  const gr2 = await fetch(`${agentBase}/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const gj2 = await gr2.json() as Record<string, unknown>;
  console.log(`  state after publish: ${gj2['state']}`);

  // Clean up
  await fetch(`${agentBase}/${agentId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`  (deleted)`);
  await new Promise(r => setTimeout(r, 1000));
}

// ── Also try: what does a Gemini Business "tool" resource look like? ──────────
// Try creating a tool resource first (if the API supports it)
console.log('\n─── Try creating a Tool resource ───');
const toolBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/tools`;
const tr = await fetch(toolBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'Confluence Knowledge Tool',
    description: 'Connector to Confluence knowledge base',
    // Try different structures for the tool
    dataStoreSpec: { dataStoreIds: [CF_DS_ID] },
  }),
});
const tt = await tr.text();
console.log(`  POST tools: ${tr.status}`);
console.log(`  ${tt.slice(0, 400)}`);

// Try GET on the data store to see if it has a "tool" view
console.log('\n─── GET data store as tool ───');
const dsr = await fetch(`${CF_DS}`, { headers: { Authorization: `Bearer ${saToken}` } });
const dsj = await dsr.json() as Record<string, unknown>;
console.log(`  DS state: ${JSON.stringify(dsj).slice(0, 500)}`);

// ── Get serving config details for the DS ──────────────────────────────────
console.log('\n─── DS serving configs ───');
const scr = await fetch(`${CF_DS}/servingConfigs`, { headers: { Authorization: `Bearer ${saToken}` } });
const scj = await scr.json() as { servingConfigs?: Array<Record<string, unknown>> };
console.log(`  ${scj.servingConfigs?.length ?? 0} serving config(s):`);
for (const sc of scj.servingConfigs ?? []) {
  console.log(`  ${JSON.stringify(sc).slice(0, 300)}`);
}
