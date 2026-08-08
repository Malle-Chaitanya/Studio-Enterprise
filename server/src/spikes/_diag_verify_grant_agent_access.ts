import 'dotenv/config';
import { grantAgentAccess, deleteAgent } from '../services/gemini.js';
import { getSaToken } from '../auth/google.js';
import type { GeminiDestination } from '../types.js';

async function main() {
  const dest: GeminiDestination = {
    project: '231705905417',
    engine: 'gemini-enterprise-17847887_1784788734248',
    assistant: 'default_assistant',
  };
  const saToken = await getSaToken();

  // Create a throwaway agent via the raw API (bypassing the full mapper, since
  // this spike only needs to test grantAgentAccess against a real agent id).
  const AGENT_BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;
  const createRes = await fetch(AGENT_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'ZZ-grant-access-test',
      description: 'throwaway probe - delete immediately',
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent',
        nodes: [{ id: 'root_agent', displayName: 'ZZ-grant-access-test', llmAgentNode: { description: 'test', model: 'gemini-2.5-flash', instruction: 'Say hello.', subAgentIds: [] } }],
      },
    }),
  });
  const created = await createRes.json() as { name?: string; error?: unknown };
  if (!created.name) throw new Error('create failed: ' + JSON.stringify(created));
  const agentId = created.name.split('/').pop()!;
  console.log('created agent:', agentId);

  const grant = await grantAgentAccess(dest, saToken, agentId, {
    users: ['austin@fuzebot.co', 'not-a-real-user-xyz@fuzebot.co'],
    groups: [],
  });
  console.log('grant result:', JSON.stringify(grant, null, 2));

  const r = await fetch(`${AGENT_BASE}/${agentId}:getIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log('getIamPolicy readback:', r.status, await r.text());

  const del = await deleteAgent(dest, saToken, agentId);
  console.log('cleanup delete:', del);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
