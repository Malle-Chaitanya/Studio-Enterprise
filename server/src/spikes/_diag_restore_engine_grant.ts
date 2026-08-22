/** Reverses _diag_remove_engine_grant.ts — adds a member back to the engine-level
 *  roles/discoveryengine.agentspaceUser binding, restoring what was removed for the
 *  clean group-sharing isolation test.
 *   npx tsx src/spikes/_diag_restore_engine_grant.ts <member, e.g. user:austin@fuzebot.co> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const MEMBER_TO_ADD = process.argv[2];

async function main() {
  if (!MEMBER_TO_ADD) throw new Error('usage: _diag_restore_engine_grant.ts <member, e.g. user:austin@fuzebot.co>');
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

  const role = 'roles/discoveryengine.agentspaceUser';
  const bindings = policy.bindings ?? [];
  const binding = bindings.find((b) => b.role === role);
  if (binding) {
    if (!binding.members.includes(MEMBER_TO_ADD)) binding.members.push(MEMBER_TO_ADD);
  } else {
    bindings.push({ role, members: [MEMBER_TO_ADD] });
  }

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
