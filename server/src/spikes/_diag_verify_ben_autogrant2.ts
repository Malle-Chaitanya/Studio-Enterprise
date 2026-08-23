import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase, type GeminiDestination } from '../services/gemini.js';

const dest: GeminiDestination = { project: '505103737920', engine: 'gemini-enterprise-app_1787446545912', assistant: 'default_assistant' };
const AGENT_ID = '12424166124128598845';

async function main() {
  const token = await getSaToken('admin@migrationn.com');

  console.log('--- Engine-level agentspaceUser (this is where grantEngineUserRole actually writes) ---');
  const engIam = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/505103737920/locations/global/collections/default_collection/engines/gemini-enterprise-app_1787446545912:getIamPolicy`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log(await engIam.text());

  console.log('\n--- Per-agent IAM policy on Migrate Advisor (retry) ---');
  const iam = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(await iam.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
