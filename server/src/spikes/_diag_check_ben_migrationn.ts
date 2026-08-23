/** Checks ben's real license and IAM state in Migrationn.com's own project (505103737920),
 *  using the credentials stored for that session's gEmail (admin@migrationn.com).
 *   npx tsx src/spikes/_diag_check_ben_migrationn.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { discoverEngines } from '../services/gemini.js';

const PROJECT = '505103737920';
const IMPERSONATE = 'admin@migrationn.com';
const BEN_EMAIL = 'ben@filefuze.co';

async function main() {
  const token = await getSaToken(IMPERSONATE);
  console.log(`Impersonating: ${IMPERSONATE}\n`);

  console.log('--- Engines in this project ---');
  const engines = await discoverEngines(PROJECT, token);
  console.log(engines.map((e) => `${e.id} (${e.solutionType})`).join('\n') || '(none found / no access)');
  if (!engines.length) { process.exit(0); }

  console.log('\n--- userLicenses in default_user_store ---');
  const licRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/userStores/default_user_store/userLicenses?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(licRes.status, await licRes.text());

  console.log('\n--- Project-level IAM: agentspaceUser members ---');
  const projRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const projBody = await projRes.json() as { bindings?: { role: string; members: string[] }[]; error?: unknown };
  console.log(JSON.stringify(projBody.error ?? (projBody.bindings ?? []).filter((b) => /discoveryengine/.test(b.role)), null, 2));

  for (const e of engines) {
    console.log(`\n--- Engine-level IAM on ${e.id} ---`);
    const engRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${e.id}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(await engRes.text());
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
