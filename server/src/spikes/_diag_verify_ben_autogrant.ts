/** Directly proves (not asserts) that ensureAgentAccess() auto-grants the missing
 *  engine role for ben@migrationn.com (who has a license but no agentspaceUser role)
 *  on a real Migrationn.com agent, before the demo.
 *   npx tsx src/spikes/_diag_verify_ben_autogrant.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { ensureAgentAccess, assistantBase, type GeminiDestination } from '../services/gemini.js';

const dest: GeminiDestination = { project: '505103737920', engine: 'gemini-enterprise-app_1787446545912', assistant: 'default_assistant' };
const AGENT_ID = '12424166124128598845'; // Migrate Advisor, from today's real migrationn.com run
const BEN = 'ben@migrationn.com';

async function main() {
  const token = await getSaToken('admin@migrationn.com');

  console.log('--- BEFORE: project-level agentspaceUser members ---');
  const before = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects/505103737920:getIamPolicy', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const beforeBody = await before.json() as { bindings?: { role: string; members: string[] }[] };
  console.log((beforeBody.bindings ?? []).find((b) => b.role === 'roles/discoveryengine.agentspaceUser')?.members ?? '(none)');

  console.log(`\n--- Running ensureAgentAccess for ${BEN} on Migrate Advisor ---`);
  const result = await ensureAgentAccess(dest, token, AGENT_ID, { users: [BEN], groups: [] }, { appUserId: 'diag-final-check', tenantId: 'diag' });
  console.log(JSON.stringify(result, null, 2));

  console.log('\n--- AFTER: project-level agentspaceUser members ---');
  const after = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects/505103737920:getIamPolicy', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const afterBody = await after.json() as { bindings?: { role: string; members: string[] }[] };
  console.log((afterBody.bindings ?? []).find((b) => b.role === 'roles/discoveryengine.agentspaceUser')?.members ?? '(none)');

  console.log('\n--- AFTER: real per-agent IAM policy on Migrate Advisor ---');
  const iam = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(await iam.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
