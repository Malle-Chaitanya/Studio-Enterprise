/** Confirm the Dataverse-snapshot data stores from today's run actually exist (and
 *  have documents) in project 231705905417 — not 72860638029, where the user was
 *  looking based on their own connected project.
 *  npx tsx src/spikes/_diag_check_dataverse_datastore.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECTS = ['231705905417', '72860638029'];

async function main() {
  const saToken = await getSaToken('zara@storefuze.com');
  for (const project of PROJECTS) {
    console.log(`\n=== project ${project} ===`);
    const res = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores?pageSize=50`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    if (!res.ok) {
      console.log(`  fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    const json = await res.json() as { dataStores?: Array<{ name: string; displayName?: string; createTime?: string }> };
    const stores = json.dataStores ?? [];
    console.log(`  ${stores.length} data store(s) total`);
    const matching = stores.filter((s) => /faqentries|cficpprofiles|bdf9b817/i.test(s.name + (s.displayName ?? '')));
    console.log(`  ${matching.length} matching this agent's snapshot naming:`);
    for (const s of matching) console.log(`    ${s.displayName ?? '(no name)'} — ${s.name} — created ${s.createTime}`);
    const recent = [...stores].sort((a, b) => (b.createTime ?? '').localeCompare(a.createTime ?? '')).slice(0, 5);
    console.log('  5 most recently created overall:');
    for (const s of recent) console.log(`    ${s.displayName ?? '(no name)'} — created ${s.createTime}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
