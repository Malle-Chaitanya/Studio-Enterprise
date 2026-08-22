/** Checks whether documents_regional is a GAUGE (current live count) or a CUMULATIVE
 *  counter (lifetime total, including deleted/re-indexed documents) — this would
 *  directly explain why 888,004 (quota) doesn't match ~700 (documents actually found
 *  across every data store right now).
 *   npx tsx src/spikes/_diag_check_metric_kind.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const projectNum = '231705905417';

  for (const metric of ['discoveryengine.googleapis.com/documents_regional', 'discoveryengine.googleapis.com/quota/documents_regional/usage']) {
    const url = `https://monitoring.googleapis.com/v3/projects/${projectNum}/metricDescriptors/${metric}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    console.log(`\n=== ${metric} ===`);
    console.log(JSON.stringify(body, null, 2).slice(0, 1200));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
