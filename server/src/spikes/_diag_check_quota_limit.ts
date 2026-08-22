/** Checks the REAL current documents_regional quota limit/usage for this project via
 *  the Service Usage API, instead of guessing a "default" number from memory.
 *   npx tsx src/spikes/_diag_check_quota_limit.ts */
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

  console.log('--- Service Usage: consumerQuotaMetrics for documents_regional ---');
  const url = `https://serviceusage.googleapis.com/v1/projects/${PROJECT_NUM}/services/discoveryengine.googleapis.com/consumerQuotaMetrics/discoveryengine.googleapis.com%2Fdocuments_regional`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(res.status, await res.text());

  console.log('\n--- Cloud Quotas API alternative (quotaInfos) ---');
  const url2 = `https://cloudquotas.googleapis.com/v1/projects/${PROJECT_NUM}/locations/global/services/discoveryengine.googleapis.com/quotaInfos/documents_regional`;
  const res2 = await fetch(url2, { headers: { Authorization: `Bearer ${token}` } });
  console.log(res2.status, await res2.text());

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
