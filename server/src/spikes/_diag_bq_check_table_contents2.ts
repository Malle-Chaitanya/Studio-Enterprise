import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATASET = 'csge_reference_snapshots';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);

  const tablesRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('status:', tablesRes.status);
  console.log(await tablesRes.text());
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(0); });
