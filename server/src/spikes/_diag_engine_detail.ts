/** Dump an engine's full config to find how it maps to the web app (cid / widget).
 *   npx tsx src/spikes/_diag_engine_detail.ts <project> <engineId>  */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = process.argv[2];
const ENGINE = process.argv[3];
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

async function main() {
  if (!PROJECT || !ENGINE) throw new Error('usage: _diag_engine_detail.ts <project> <engineId>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  const base = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}`;
  const engRes = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
  console.log('=== ENGINE ===', engRes.status);
  console.log((await engRes.text()));

  // Widget/config often carries the web-app "cid" (uiSettings / widgetConfigs).
  for (const sub of ['widgetConfigs', 'uiSettings', 'assistants']) {
    const r = await fetch(`${base}/${sub}`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`\n=== ${sub} ===`, r.status);
    const t = await r.text();
    console.log(t.slice(0, 1500));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
