/** Dump the project's IAM allow-policy (v3, includes conditions) — find our SA's
 *  bindings and whether any is CONDITIONAL (which would explain an Owner being
 *  denied dialogflow.agents.create). */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT] = process.argv.slice(2);
const SA = 'studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com';

async function main() {
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
  });
  const j = (await r.json()) as { bindings?: { role: string; members: string[]; condition?: { title?: string; expression?: string } }[]; error?: { message?: string } };
  console.log(`getIamPolicy -> ${r.status}`);
  if (j.error) { console.log(j.error.message); process.exit(0); }
  console.log(`\nBindings that include our SA (${SA}):`);
  for (const b of j.bindings ?? []) {
    if (b.members.some((m) => m.includes(SA))) {
      console.log(`  role=${b.role}${b.condition ? `  ⚠️ CONDITIONAL: ${b.condition.title} — ${b.condition.expression}` : '  (no condition)'}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
