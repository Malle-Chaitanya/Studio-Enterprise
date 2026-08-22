import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT_NUM = '231705905417';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  const url = `https://serviceusage.googleapis.com/v1beta1/projects/${PROJECT_NUM}/services/discoveryengine.googleapis.com/consumerQuotaMetrics/discoveryengine.googleapis.com%2Fdocuments_regional?view=FULL`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(res.status);
  console.log(await res.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
