/** Sanity check: does the license API even correctly report ANYONE as licensed on this
 *  tenant, or is the whole check broken (wrong userStore id)? Tests zara (definitely
 *  active, real admin) and austin, and also lists ALL licenses the store actually has.
 *   npx tsx src/spikes/_diag_sanity_check_license_api.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const project = 'studio-enterprise-migration';
  const storeUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/userStores/default_user_store`;

  console.log('--- Does default_user_store exist at all? ---');
  const storeRes = await fetch(storeUrl, { headers: { Authorization: `Bearer ${token}` } });
  console.log(storeRes.status, (await storeRes.text()).slice(0, 300));

  console.log('\n--- ALL userLicenses in this store (no filter) ---');
  const allRes = await fetch(`${storeUrl}/userLicenses?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(allRes.status, (await allRes.text()).slice(0, 3000));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
