import { getSaToken } from '../auth/google.js';
const PROJECT='505103737920', ENGINE='gemini-enterprise-app_1787446545912';
const AGENT='4839019307637799308';
const base=`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant`;
const agentRes=`projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;
const token=await getSaToken('admin@migrationn.com');
const variants: Record<string, unknown> = {
  'no agent at all': { query: { text: 'hi' } },
  'agentsConfig.agent (full resource)': { query: { text: 'hi' }, agentsConfig: { agent: agentRes } },
  'agentsConfig.agent (bare id)': { query: { text: 'hi' }, agentsConfig: { agent: AGENT } },
  'agent (full resource)': { query: { text: 'hi' }, agent: agentRes },
  'assistantConfig.agent': { query: { text: 'hi' }, assistantConfig: { agent: agentRes } },
};
for (const [label, body] of Object.entries(variants)) {
  const res = await fetch(`${base}:assist`, {
    method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  const t = await res.text();
  console.log(`\n### ${label}\n    HTTP ${res.status}  ${t.replace(/\s+/g,' ').slice(0,260)}`);
}
