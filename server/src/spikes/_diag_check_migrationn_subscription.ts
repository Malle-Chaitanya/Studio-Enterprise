/** Which Gemini Enterprise subscription/edition backs Migrationn.com's project
 *  (505103737920) — free trial vs paid? Dumps the engine's raw fields plus any
 *  licence/subscription resources the v1alpha API exposes.
 *   npx tsx src/spikes/_diag_check_migrationn_subscription.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '505103737920';
const PARENT = `projects/${PROJECT}/locations/global/collections/default_collection`;

async function main() {
  const token = await getSaToken('admin@migrationn.com');

  const r = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${PARENT}/engines?pageSize=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as { engines?: Array<Record<string, any>> };
  for (const e of j.engines ?? []) {
    console.log(`\n=== ${String(e.name).split('/').pop()} (${e.displayName}) ===`);
    for (const [k, v] of Object.entries(e)) {
      if (['name', 'displayName', 'dataStoreIds'].includes(k)) continue;
      console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 400) : String(v)}`);
    }
  }

  for (const path of ['licenseConfigs', 'userLicenses', 'subscriptions']) {
    const lr = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await lr.text()).slice(0, 500);
    console.log(`\nGET ${path} -> ${lr.status} ${body}`);
  }

  console.log('\n--- Cloud Billing info for the project ---');
  const bRes = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(bRes.status, (await bRes.text()).slice(0, 500));

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
