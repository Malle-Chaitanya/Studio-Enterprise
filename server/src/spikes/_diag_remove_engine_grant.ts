/** Removes one principal from the engine-level roles/discoveryengine.agentspaceUser
 *  binding — completes the "clean group-sharing test" by closing the second, engine-
 *  scoped access path that the Cloud Console IAM page never shows (project-level IAM
 *  and engine-level IAM are two separate policies on two separate resources).
 *   npx tsx src/spikes/_diag_remove_engine_grant.ts <memberToRemove, e.g. user:austin@fuzebot.co> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const MEMBER_TO_REMOVE = process.argv[2];

async function main() {
  if (!MEMBER_TO_REMOVE) throw new Error('usage: _diag_remove_engine_grant.ts <member, e.g. user:austin@fuzebot.co>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  const token = await getSaToken(impersonate);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const engineBase = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const getRes = await fetch(`${engineBase}:getIamPolicy`, { method: 'GET', headers: h });
  const policy = (await getRes.json()) as { bindings?: { role: string; members: string[] }[]; etag?: string; version?: number };
  console.log('BEFORE:', JSON.stringify(policy, null, 2));

  let removed = false;
  for (const b of policy.bindings ?? []) {
    const idx = b.members.indexOf(MEMBER_TO_REMOVE);
    if (idx !== -1) {
      b.members.splice(idx, 1);
      removed = true;
      console.log(`Removed ${MEMBER_TO_REMOVE} from ${b.role}`);
    }
  }
  if (!removed) {
    console.log(`${MEMBER_TO_REMOVE} was not found in any binding — nothing to do.`);
    process.exit(0);
  }
  // Drop any binding left with zero members — an empty members array is invalid.
  const bindings = (policy.bindings ?? []).filter((b) => b.members.length > 0);

  const setRes = await fetch(`${engineBase}:setIamPolicy`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ policy: { bindings, etag: policy.etag, version: policy.version } }),
  });
  console.log(`\n:setIamPolicy -> ${setRes.status}`);
  console.log(await setRes.text());

  const verifyRes = await fetch(`${engineBase}:getIamPolicy`, { method: 'GET', headers: h });
  console.log('\nAFTER:', await verifyRes.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
