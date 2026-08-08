import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';

async function main() {
  const key = JSON.parse(readFileSync('C:/Users/ChaitanyaMalle/CS_GE/service_account.json', 'utf8'));
  const PROJECT = '231705905417';
  const ENGINE = 'gemini-enterprise-17847887_1784788734248';
  const AGENT_BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

  const austinClient = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'], subject: 'austin@fuzebot.co' });
  const austinTok = (await austinClient.authorize()).access_token;

  const createRes = await fetch(AGENT_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${austinTok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'ZZ-edit-rights-test',
      description: 'throwaway - delete immediately',
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent',
        nodes: [{ id: 'root_agent', displayName: 'ZZ-edit-rights-test', llmAgentNode: { description: 'test', model: 'gemini-2.5-flash', instruction: 'Say hello.', subAgentIds: [] } }],
      },
    }),
  });
  const created = (await createRes.json()) as { name?: string };
  if (!created.name) throw new Error('create failed: ' + JSON.stringify(created));
  const agentId = created.name.split('/').pop();
  console.log('created as Austin:', agentId);

  // Austin tries to EDIT his own created agent (rename it).
  const patchRes = await fetch(`${AGENT_BASE}/${agentId}?updateMask=displayName`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${austinTok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'ZZ-edit-rights-test-RENAMED-BY-AUSTIN' }),
  });
  console.log('Austin PATCH (rename) status:', patchRes.status);
  console.log(await patchRes.text());

  // For comparison: can a totally unrelated user (e.g. a fresh impersonation of someone with NO role at all
  // on this agent) do the same? Try with frankie (real workspace user, but not owner of this agent).
  const frankieClient = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'], subject: 'frankie@fuzebot.co' });
  const frankieTok = (await frankieClient.authorize()).access_token;
  const patchRes2 = await fetch(`${AGENT_BASE}/${agentId}?updateMask=displayName`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${frankieTok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'ZZ-edit-rights-test-RENAMED-BY-FRANKIE' }),
  });
  console.log('Frankie (non-owner) PATCH (rename) status:', patchRes2.status);
  console.log(await patchRes2.text());

  const saClient = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const saTok = (await saClient.authorize()).access_token;
  const del = await fetch(`${AGENT_BASE}/${agentId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saTok}` } });
  console.log('cleanup:', del.status);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
