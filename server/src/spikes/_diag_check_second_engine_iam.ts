/** Checks whether the second engine (geminienterprise_1787125371767) already has any
 *  engine-level IAM bindings (roles/discoveryengine.agentspaceUser — "Gemini Enterprise
 *  User"), to answer: can it be used for testing as-is, or does IAM need setting up first?
 *   npx tsx src/spikes/_diag_check_second_engine_iam.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT_NUM = '231705905417';
const ENGINE = 'geminienterprise_1787125371767';
const engineUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT_NUM}/locations/global/collections/default_collection/engines/${ENGINE}`;

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  console.log('--- Engine-level IAM (roles/discoveryengine.agentspaceUser scope) ---');
  const engineIam = await fetch(`${engineUrl}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(engineIam.status, await engineIam.text());

  console.log('\n--- Project-level IAM (Cloud Resource Manager) ---');
  const projIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_NUM}:getIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const projBody = await projIam.json() as { bindings?: { role: string; members: string[] }[] };
  const relevant = (projBody.bindings ?? []).filter((b) => /discoveryengine/.test(b.role));
  console.log(projIam.status, JSON.stringify(relevant, null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
