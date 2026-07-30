/** Check for IAM v2 DENY policies on the project — a deny overrides any allow
 *  (even Owner), which would explain why the SA is refused dialogflow.agents.create. */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT] = process.argv.slice(2);

async function main() {
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const attach = encodeURIComponent(`cloudresourcemanager.googleapis.com/projects/${PROJECT}`);
  const r = await fetch(`https://iam.googleapis.com/v2/policies/${attach}/denypolicies`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as { policies?: unknown[]; error?: { message?: string } };
  console.log(`list deny policies -> ${r.status}`);
  if (j.error) { console.log('  ', j.error.message); process.exit(0); }
  if (!j.policies?.length) { console.log('  ✅ NO deny policies found — so it is propagation delay, not a deny.'); process.exit(0); }
  console.log(`  ⚠️ ${j.policies.length} deny policy(ies) found:`);
  console.log(JSON.stringify(j.policies, null, 2).slice(0, 2000));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
