/** Does the Dataverse-snapshot data store actually return anything? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

await connectMongo();
const res = await getDb().collection('migrationResults').find({}).sort({ _id: -1 }).limit(6).toArray();
const stores = new Set<string>();
for (const r of res as any[]) {
  for (const s of r.dataStores ?? r.knowledgeDataStores ?? []) stores.add(typeof s === 'string' ? s : s.resourcePath ?? JSON.stringify(s));
  const j = JSON.stringify(r);
  for (const m of j.matchAll(/projects\/[^"]*?dataStores\/[a-zA-Z0-9_\-]+/g)) stores.add(m[0]);
}
console.log('data stores seen:', [...stores]);
const token = await getSaToken();
for (const path of stores) {
  if (!/dataStores\//.test(path)) continue;
  const url = `https://discoveryengine.googleapis.com/v1beta/${path}/servingConfigs/default_search:search`;
  for (const mode of ['DOCUMENTS', 'CHUNKS']) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'ICP', pageSize: 3, contentSearchSpec: { searchResultMode: mode } }),
    });
    const body = await r.text();
    console.log(`\n${path.split('/').pop()} [${mode}] HTTP ${r.status}: ${body.slice(0, 400)}`);
  }
}
process.exit(0);
