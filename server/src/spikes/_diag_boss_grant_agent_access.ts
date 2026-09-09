import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'global';
const ENGINE = 'gemini-enterprise-app_1787446545912';
const AGENT_ID = '10776999723910816732'; // Migrate Advisor
const SERVICE_ACCOUNT_MEMBER = 'serviceAccount:connectors@agentmigrations.iam.gserviceaccount.com';
const ROLE = 'roles/discoveryengine.agentUser';

async function main() {
  const token = await getSaToken();
  const agentPath = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT_ID}`;

  const getRes = await fetch(`${agentPath}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('getIamPolicy status:', getRes.status);
  const existing = getRes.ok ? await getRes.json() : {};
  console.log('Existing policy:', JSON.stringify(existing, null, 2));

  const bindings = existing.bindings ?? [];
  const binding = bindings.find((b) => b.role === ROLE);
  const already = new Set(binding?.members ?? []);
  if (already.has(SERVICE_ACCOUNT_MEMBER)) {
    console.log('Already granted — nothing to do.');
    process.exit(0);
  }
  if (binding) binding.members = [...already, SERVICE_ACCOUNT_MEMBER];
  else bindings.push({ role: ROLE, members: [SERVICE_ACCOUNT_MEMBER] });

  const setRes = await fetch(`${agentPath}:setIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: { bindings, etag: existing.etag } }),
  });
  console.log('setIamPolicy status:', setRes.status);
  console.log(await setRes.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
