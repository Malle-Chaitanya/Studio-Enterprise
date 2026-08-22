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
  const url = `https://monitoring.googleapis.com/v3/projects/${projectNum}/metricDescriptors?filter=${encodeURIComponent('metric.type=starts_with("discoveryengine.googleapis.com/")')}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json() as { metricDescriptors?: { type: string }[] };
  for (const m of body.metricDescriptors ?? []) {
    if (/doc/i.test(m.type)) console.log(m.type);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
