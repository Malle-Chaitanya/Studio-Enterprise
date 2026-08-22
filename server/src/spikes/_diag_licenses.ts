/** Licence configs and user seats. A Gemini subscription grants SEATS to users; the engine
 *  (the app that serves agents) is a separate resource that outlives a subscription. Which of
 *  those two changed decides whether anything needs migrating at all. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = '231705905417';
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
const get = async (p: string) => {
  try {
    const r = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: `network: ${(e as Error).message}` };
  }
};

const lc = await get('licenseConfigs');
console.log(`licenseConfigs -> ${lc.status}`);
if (lc.status === 200) {
  const j = JSON.parse(lc.body) as { licenseConfigs?: Array<Record<string, any>> };
  for (const c of j.licenseConfigs ?? []) {
    const d = (x: any) => (x ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : '-');
    console.log(`  ${String(c.name).split('/').pop()}  seats=${c.licenseCount}  tier=${c.subscriptionTier}  state=${c.state}  ${d(c.startDate)} -> ${d(c.endDate)}  autoRenew=${c.autoRenew}`);
  }
}

const ul = await get('userStores/default_user_store/userLicenses');
console.log(`\nuserLicenses -> ${ul.status}`);
if (ul.status === 200) {
  const j = JSON.parse(ul.body) as { userLicenses?: Array<Record<string, any>> };
  const rows = j.userLicenses ?? [];
  console.log(`  ${rows.length} user licence row(s)`);
  for (const u of rows.slice(0, 15)) {
    console.log(`   ${String(u.userPrincipal ?? u.userProfile ?? '?').padEnd(38)} state=${u.licenseAssignmentState ?? '-'}  config=${String(u.licenseConfig ?? '-').split('/').pop()}`);
  }
} else {
  console.log(`  ${ul.body.slice(0, 300)}`);
}
process.exit(0);
