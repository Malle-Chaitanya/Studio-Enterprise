import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = 'projects/studio-enterprise-migration/locations/global/collections/default_collection/dataStores';
const IDS = [
  'bdf9b817-9b90-f111-b8da-0022480b1f83-tbl-cr88d-cficpprofiles',
  'bdf9b817-9b90-f111-b8da-0022480b1f83-tbl-cr88d-faqentries',
];
const token = await getSaToken();
for (const id of IDS) {
  const docs = await fetch(`https://discoveryengine.googleapis.com/v1beta/${P}/${id}/branches/default_branch/documents?pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
  const dj = (await docs.json()) as any;
  const n = (dj.documents ?? []).length;
  const first = dj.documents?.[0]?.structData ?? {};
  console.log(`\n=== ${id}\n  documents=${n}  fields=${Object.keys(first).slice(0, 12).join(',')}`);
  for (const q of ['ICP', 'profile', 'what is our ICP', Object.values(first).find((v) => typeof v === 'string' && v.length > 4 && v.length < 40) as string ?? 'test']) {
    const r = await fetch(`https://discoveryengine.googleapis.com/v1beta/${P}/${id}/servingConfigs/default_search:search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, pageSize: 5, contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
    });
    const j = (await r.json()) as any;
    console.log(`  query "${q}" -> ${r.status} results=${(j.results ?? []).length} totalSize=${j.totalSize ?? 0}`);
  }
}
process.exit(0);
