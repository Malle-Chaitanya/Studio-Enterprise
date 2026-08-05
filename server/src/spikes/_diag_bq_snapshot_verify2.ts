import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'spiketest-bqreal-msed0cag-tbl-contacts';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);

  const docsUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/documents`;
  const res = await fetch(docsUrl, { headers: { Authorization: `Bearer ${token}` } });
  console.log('documents list status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(0); });
