/** Tests whether this service account/impersonation can read+write PROJECT-level IAM
 *  (Cloud Resource Manager) — a different API entirely from Discovery Engine's
 *  engine-level/agent-level IAM used elsewhere in this codebase. If it works, restores
 *  austin@fuzebot.co's project-level "Gemini Enterprise User" (roles/discoveryengine.
 *  agentspaceUser bound at the PROJECT resource, not the engine resource) that was
 *  removed manually via Cloud Console during testing.
 *   npx tsx src/spikes/_diag_test_project_iam.ts <projectId> <member> */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT_ID, MEMBER] = process.argv.slice(2);

async function main() {
  if (!PROJECT_ID || !MEMBER) throw new Error('usage: _diag_test_project_iam.ts <projectId> <member>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || 'zara@storefuze.com');
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}`;

  console.log('=== Testing read access (getIamPolicy) ===');
  const getRes = await fetch(`${base}:getIamPolicy`, { method: 'POST', headers: h, body: '{}' });
  console.log(`:getIamPolicy -> ${getRes.status}`);
  if (!getRes.ok) {
    console.log(await getRes.text());
    console.log('\nNo read access to project-level IAM — cannot proceed with restore via API.');
    process.exit(0);
  }
  const policy = (await getRes.json()) as { bindings?: { role: string; members: string[] }[]; etag?: string; version?: number };
  const role = 'roles/discoveryengine.agentspaceUser';
  const binding = policy.bindings?.find((b) => b.role === role);
  console.log(`Current members of ${role}:`, binding?.members ?? '(role not present in project policy)');

  if (binding?.members.includes(MEMBER)) {
    console.log(`\n${MEMBER} already present in ${role} at project level — nothing to restore.`);
    process.exit(0);
  }

  console.log('\n=== Read succeeded — attempting write (setIamPolicy) to restore the grant ===');
  const bindings = policy.bindings ?? [];
  if (binding) binding.members.push(MEMBER);
  else bindings.push({ role, members: [MEMBER] });

  const setRes = await fetch(`${base}:setIamPolicy`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ policy: { bindings, etag: policy.etag, version: policy.version } }),
  });
  console.log(`:setIamPolicy -> ${setRes.status}`);
  console.log(await setRes.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
