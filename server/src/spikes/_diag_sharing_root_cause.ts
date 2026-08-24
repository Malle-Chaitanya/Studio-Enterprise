/** Decisive live test: given the CORRECT (email-keyed) identity override for
 *  Migrationn.com, does the full ensureAgentAccess chain (license check/assign
 *  -> engine-role grant -> per-agent grant) actually succeed right now for the
 *  three agents that showed "0 principal(s)" in the deployed run
 *  (M94r0za3xXtkJuC3Xvn7KVd1LQc)? This isolates whether the remaining problem
 *  is (a) already fixed by the override-key fix + a correct saved mapping, or
 *  (b) a real, separate bug in the grant chain itself.
 *   npx tsx src/spikes/_diag_sharing_root_cause.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { checkUserLicense, ensureAgentAccess, assistantBase, type GeminiDestination } from '../services/gemini.js';

const dest: GeminiDestination = { project: '505103737920', engine: 'gemini-enterprise-app_1787446545912', assistant: 'default_assistant' };
const GRANT_USERS = ['admin@migrationn.com', 'alex@migrationn.com', 'ben@migrationn.com'];

async function main() {
  const token = await getSaToken('admin@migrationn.com');

  console.log('--- Discover current agents in the engine ---');
  const listRes = await fetch(`${assistantBase(dest)}/agents?pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
  const list = (await listRes.json()) as { agents?: { name: string; displayName?: string }[] };
  const agents = list.agents ?? [];
  for (const a of agents) console.log(`${a.displayName}\t${a.name.split('/').pop()}`);

  const targets = ['WorkMate', 'Nexus Agent', 'Migrate Advisor'];
  for (const name of targets) {
    const a = agents.find((x) => x.displayName === name);
    if (!a) { console.log(`\n[${name}] NOT FOUND in current engine listing — skipping`); continue; }
    const agentId = a.name.split('/').pop()!;
    console.log(`\n=== ${name} (${agentId}) ===`);

    for (const email of GRANT_USERS) {
      const license = await checkUserLicense(dest, token, email);
      console.log(`  license(${email}) = ${license}`);
    }

    const result = await ensureAgentAccess(dest, token, agentId, { users: GRANT_USERS, groups: [] }, { appUserId: 'diag-root-cause', tenantId: 'diag' });
    console.log('  ensureAgentAccess result:', JSON.stringify(result));

    const iamRes = await fetch(`${assistantBase(dest)}/agents/${agentId}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
    console.log('  live per-agent IAM policy:', await iamRes.text());
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
