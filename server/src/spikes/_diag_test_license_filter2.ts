import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const storeUrl = 'https://discoveryengine.googleapis.com/v1alpha/projects/studio-enterprise-migration/locations/global/userStores/default_user_store';

  const variants = [
    `user_principal:"austin@fuzebot.co"`,
    `user_principal = "austin@fuzebot.co"`,
    `userPrincipal:"austin@fuzebot.co"`,
    `principal="austin@fuzebot.co"`,
  ];
  for (const filterExpr of variants) {
    const res = await fetch(`${storeUrl}/userLicenses?filter=${encodeURIComponent(filterExpr)}`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`\nfilter=[${filterExpr}] ->`, res.status, (await res.text()).slice(0, 300));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
