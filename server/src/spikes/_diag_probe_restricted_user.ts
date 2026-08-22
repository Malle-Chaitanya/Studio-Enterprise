/** Closes PERMISSION-MAPPING-ARCHITECTURE.md open question #3: what does
 *  roles/discoveryengine.agentspaceRestrictedUser actually restrict, compared to plain
 *  roles/discoveryengine.agentspaceUser (services/gemini.ts:371, grantEngineUserRole)?
 *  Google's own role description names the engine as this role's intended scope (per the
 *  comment at gemini.ts:265-267) but the exact permission delta has never been confirmed
 *  against a live tenant. This grants BOTH roles to two different throwaway test
 *  principals on the same engine so their effective access can be diffed by hand
 *  afterward (this script only does the grant + read-back; the actual comparison needs a
 *  real login from each test user — see the printed next-step checklist).
 *  No mongo. Token via SA key + GOOGLE_IMPERSONATE_EMAIL.
 *   npx tsx src/spikes/_diag_probe_restricted_user.ts <project> <engineId> <restrictedUserEmail> <normalUserEmail> */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE, RESTRICTED_EMAIL, NORMAL_EMAIL] = process.argv.slice(2);
const ENGINE_BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}`;

async function grant(token: string, role: string, email: string) {
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const getRes = await fetch(`${ENGINE_BASE}:getIamPolicy`, { method: 'GET', headers: h });
  const existing = getRes.ok
    ? ((await getRes.json()) as { bindings?: { role: string; members: string[] }[]; etag?: string })
    : {};
  const bindings = existing.bindings ?? [];
  const binding = bindings.find((b) => b.role === role);
  const member = `user:${email.toLowerCase()}`;
  if (binding) {
    if (!binding.members.includes(member)) binding.members.push(member);
  } else {
    bindings.push({ role, members: [member] });
  }
  const setRes = await fetch(`${ENGINE_BASE}:setIamPolicy`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ policy: { bindings, etag: existing.etag } }),
  });
  const text = (await setRes.text()).replace(/\s+/g, ' ').slice(0, 220);
  console.log(`  grant ${role} -> ${email}: ${setRes.status}  ${setRes.ok ? '(ok)' : text}`);
  return setRes.ok;
}

async function readBack(token: string) {
  const getRes = await fetch(`${ENGINE_BASE}:getIamPolicy`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const policy = (await getRes.json()) as { bindings?: { role: string; members: string[] }[] };
  console.log('\nEffective engine IAM policy after grants:');
  for (const b of policy.bindings ?? []) {
    if (b.role.includes('agentspace')) console.log(`  ${b.role}: ${b.members.join(', ')}`);
  }
}

async function main() {
  if (!PROJECT || !ENGINE || !RESTRICTED_EMAIL || !NORMAL_EMAIL) {
    throw new Error('usage: _diag_probe_restricted_user.ts <project> <engineId> <restrictedUserEmail> <normalUserEmail>');
  }
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);

  console.log(`Granting agentspaceRestrictedUser to ${RESTRICTED_EMAIL} and agentspaceUser to ${NORMAL_EMAIL} on engine ${ENGINE}...`);
  await grant(token, 'roles/discoveryengine.agentspaceRestrictedUser', RESTRICTED_EMAIL);
  await grant(token, 'roles/discoveryengine.agentspaceUser', NORMAL_EMAIL);
  await readBack(token);

  console.log(
    '\nGrants issued. This script cannot itself confirm the behavioral difference — that requires ' +
      'two real logins. Next steps (manual):\n' +
      `  1. Have ${RESTRICTED_EMAIL} log into the Gemini Enterprise web app for this engine.\n` +
      `  2. Have ${NORMAL_EMAIL} do the same.\n` +
      '  3. Compare: can the restricted-user account see the same agent gallery, the same data ' +
      'stores/connectors, the same admin surfaces? Any difference IS the semantic delta this ' +
      'question is trying to close — record it in PERMISSION-MAPPING-ARCHITECTURE.md B.1.\n' +
      '  4. If no observable difference turns up, treat agentspaceRestrictedUser as equivalent to ' +
      'agentspaceUser for this tool\'s purposes rather than leaving it an open question indefinitely.',
  );
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});