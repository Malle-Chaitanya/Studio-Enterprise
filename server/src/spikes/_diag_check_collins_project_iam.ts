/** READ-ONLY. Captures Collins's exact current project-level IAM bindings before we
 *  remove anything, so we can restore him precisely afterward (same pattern as the
 *  earlier Austin isolation test).
 *   npx tsx src/spikes/_diag_check_collins_project_iam.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT_NUM = '231705905417';
const PRINCIPAL = 'user:collins-gd@storefuze.com';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_NUM}:getIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json() as { bindings?: { role: string; members: string[] }[] };
  const collinsRoles = (body.bindings ?? []).filter((b) => b.members.includes(PRINCIPAL)).map((b) => b.role);
  console.log('Collins currently holds these PROJECT-level roles:');
  console.log(JSON.stringify(collinsRoles, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
