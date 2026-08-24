import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { checkUserLicense, ensureAgentAccess, assistantBase, type GeminiDestination } from '../services/gemini.js';

const dest: GeminiDestination = { project: '505103737920', engine: 'gemini-enterprise-app_1787446545912', assistant: 'default_assistant' };
const AGENT_ID = '8457590648270149777';
const USERS = ['admin@migrationn.com', 'alex@migrationn.com', 'ben@migrationn.com'];

async function main() {
  const token = await getSaToken('admin@migrationn.com');
  for (const email of USERS) {
    const state = await checkUserLicense(dest, token, email);
    console.log('license', email, '=', state);
  }
  const result = await ensureAgentAccess(dest, token, AGENT_ID, { users: USERS, groups: [] }, { appUserId: 'diag-live', tenantId: 'diag' });
  console.log('ensureAgentAccess result:', JSON.stringify(result, null, 2));

  const iamRes = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('live per-agent IAM policy:', await iamRes.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
