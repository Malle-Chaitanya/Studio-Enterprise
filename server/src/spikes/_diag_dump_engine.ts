import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;
  for (const suffix of ['', '?view=FULL', '?view=ENGINE_VIEW_FULL']) {
    const res = await fetch(base + suffix, { headers: { Authorization: `Bearer ${saToken}` } });
    const json = await res.json().catch(() => ({}));
    console.log(`\n--- GET ${suffix || '(default)'} -> ${res.status} ---`);
    console.log('dataStoreIds:', JSON.stringify((json as { dataStoreIds?: unknown }).dataStoreIds));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
