import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';

async function main() {
  const key = JSON.parse(readFileSync('C:/Users/ChaitanyaMalle/CS_GE/service_account.json', 'utf8'));
  const PROJECT = '231705905417';
  const ENGINE = 'gemini-enterprise-17847887_1784788734248';
  const AGENT_BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

  const client = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'], subject: 'austin@fuzebot.co' });
  const tok = (await client.authorize()).access_token;

  const createRes = await fetch(AGENT_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'ZZ-austin-reverify-test',
      description: 'throwaway - delete immediately',
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent',
        nodes: [{ id: 'root_agent', displayName: 'ZZ-austin-reverify-test', llmAgentNode: { description: 'test', model: 'gemini-2.5-flash', instruction: 'Say hello.', subAgentIds: [] } }],
      },
    }),
  });
  const created = await createRes.json();
  if (!created.name) throw new Error('create failed: ' + JSON.stringify(created));
  const agentId = created.name.split('/').pop();
  console.log('created (as Austin):', agentId);

  const path = `projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${agentId}`;
  const iamRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${path}:getIamPolicy`, { method: 'GET', headers: { Authorization: `Bearer ${tok}` } });
  console.log('IAM policy (as Austin token):', iamRes.status, await iamRes.text());

  // Also check with the bare SA (no impersonation) to rule out a per-viewer-different-answer artifact.
  const saClient = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const saTok = (await saClient.authorize()).access_token;
  const iamRes2 = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${path}:getIamPolicy`, { method: 'GET', headers: { Authorization: `Bearer ${saTok}` } });
  console.log('IAM policy (as bare SA):', iamRes2.status, await iamRes2.text());

  const del = await fetch(`${AGENT_BASE}/${agentId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saTok}` } });
  console.log('cleanup:', del.status);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
