import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'spiketest-bqreal-msedu8r2-tbl-contacts';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);

  const docsUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/documents`;
  const res = await fetch(docsUrl, { headers: { Authorization: `Bearer ${token}` } });
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 4000));

  // Also confirm the BigQuery table itself has the shaped schema
  const tblRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/csge_reference_snapshots/tables/spiketest_bqreal_msedu8r2_tbl_contacts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tblJson = await tblRes.json();
  console.log('\nBigQuery table field count:', (tblJson as any).schema?.fields?.length);
  console.log('Sample fields:', JSON.stringify((tblJson as any).schema?.fields?.filter((f: any) => f.name.startsWith('owner') || f.name === 'id' || f.name === 'fullname').map((f: any) => `${f.name}:${f.type}`), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(0); });
