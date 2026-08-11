import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function main() {
  const saToken = await getSaToken();
  const PROJECT = '231705905417';
  const ENGINE = 'gemini-enterprise-17847887_1784788734248';
  const AGENT_BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

  const createRes = await fetch(AGENT_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'ZZ-iampolicy-probe',
      description: 'throwaway - delete immediately',
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent',
        nodes: [{ id: 'root_agent', displayName: 'ZZ-iampolicy-probe', llmAgentNode: { description: 'test', model: 'gemini-2.5-flash', instruction: 'Say hello.', subAgentIds: [] } }],
      },
    }),
  });
  const created = await createRes.json() as { name?: string };
  if (!created.name) throw new Error('create failed: ' + JSON.stringify(created));
  const agentId = created.name.split('/').pop();
  console.log('created (live):', agentId);

  const candidates = [
    `projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${agentId}`,
    `projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/agents/${agentId}`,
  ];
  for (const path of candidates) {
    const url = `https://discoveryengine.googleapis.com/v1alpha/${path}:getIamPolicy`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    console.log(path);
    console.log('  ->', res.status, (await res.text()).slice(0, 250).replace(/\n/g, ' '));
  }

  const del = await fetch(`${AGENT_BASE}/${agentId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } });
  console.log('cleanup:', del.status);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
