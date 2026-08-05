import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'csge-bq-sanity-test';
const SECRET_CODE = 'BQPIPE-4471-XQ';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);

  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_search:search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'Zzqcheck Testperson842', pageSize: 5 }),
  });
  const text = await res.text();
  console.log('status:', res.status);
  console.log(text.slice(0, 3000));
  console.log(`\nExpected secret code: ${SECRET_CODE}`);
  console.log(text.includes(SECRET_CODE) ? '\n✅ FOUND — the BigQuery-sourced row IS indexed and searchable.' : '\n❌ NOT found in search results.');
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(0); });
