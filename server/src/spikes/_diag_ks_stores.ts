/** List data stores in the destination project and search the Dataverse one. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = 'studio-enterprise-migration';
const token = await getSaToken();
const list = await fetch(
  `https://discoveryengine.googleapis.com/v1beta/projects/${PROJECT}/locations/global/collections/default_collection/dataStores?pageSize=100`,
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!list.ok) { console.log(`list HTTP ${list.status}: ${(await list.text()).slice(0, 300)}`); process.exit(0); }
const stores = ((await list.json()) as any).dataStores ?? [];
console.log(`data stores: ${stores.length}`);
for (const s of stores) console.log(`  ${s.name.split('/').pop()}  "${s.displayName}"  content=${s.contentConfig ?? '?'}  solution=${(s.solutionTypes ?? []).join(',')}`);
process.exit(0);
