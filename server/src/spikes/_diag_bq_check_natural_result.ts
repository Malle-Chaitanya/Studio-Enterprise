import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'spiketest-natural-msefapld-tbl-systemusers';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);

  // How many documents actually landed?
  const docsRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/documents?pageSize=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const docsText = await docsRes.text();
  console.log('documents list status:', docsRes.status);
  console.log(docsText.slice(0, 1500));

  // List recent import operations on this data store to see the raw LRO metadata
  const opsRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/operations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('\noperations list status:', opsRes.status);
  console.log((await opsRes.text()).slice(0, 3000));
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(0); });
