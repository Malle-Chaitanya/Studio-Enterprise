/** Which subscription/licence backs each engine? A Gemini subscription is bought on the billing
 *  account, but the ENGINE is what serves agents — so "the licence expired" only tells us where
 *  to migrate if the engine resource says which licence it carries. Dump the raw fields. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = 'studio-enterprise-migration';
const PARENT = `projects/${PROJECT}/locations/global/collections/default_collection`;
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
const r = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${PARENT}/engines?pageSize=50`, {
  headers: { Authorization: `Bearer ${token}` },
});
const j = (await r.json()) as { engines?: Array<Record<string, any>> };
for (const e of j.engines ?? []) {
  console.log(`\n=== ${String(e.name).split('/').pop()} (${e.displayName}) ===`);
  for (const [k, v] of Object.entries(e)) {
    if (['name', 'displayName', 'dataStoreIds'].includes(k)) continue;
    console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 260) : String(v)}`);
  }
}
// Licence configs are a separate resource in v1alpha; list them if the API exposes any.
for (const path of ['licenseConfigs', 'userLicenses', 'subscriptions']) {
  const lr = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await lr.text()).slice(0, 400);
  console.log(`\nGET ${path} -> ${lr.status} ${body}`);
}
process.exit(0);
