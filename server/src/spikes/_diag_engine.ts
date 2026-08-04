/**
 * Read-only inspection of the Gemini Enterprise ENGINE and its data stores.
 * Reveals how websites/data stores attach (engine.dataStoreIds vs. per-agent),
 * so we can wire the website-knowledge path correctly instead of guessing.
 *
 *   npx tsx src/spikes/_diag_engine.ts
 *
 * READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';

const HOST = 'https://discoveryengine.googleapis.com';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);
  const collection = `${HOST}/v1alpha/projects/${dest.project}/locations/global/collections/default_collection`;

  // 1. The engine — does it carry dataStoreIds? what type is it?
  console.log(`\n=== ENGINE: ${dest.engine} ===`);
  const engRes = await fetch(`${collection}/engines/${dest.engine}`, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!engRes.ok) {
    console.log(`GET engine failed (${engRes.status}): ${(await engRes.text()).slice(0, 200)}`);
  } else {
    const eng = (await engRes.json()) as Record<string, unknown>;
    console.log('top-level keys:', Object.keys(eng).join(', '));
    console.log('dataStoreIds:', JSON.stringify(eng.dataStoreIds ?? '(none)'));
    console.log('\nFULL ENGINE JSON:\n' + JSON.stringify(eng, null, 2));
  }

  // 2. Existing data stores in the collection (what shapes look like).
  console.log(`\n=== DATA STORES in default_collection ===`);
  const dsRes = await fetch(`${collection}/dataStores`, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!dsRes.ok) {
    console.log(`list dataStores failed (${dsRes.status}): ${(await dsRes.text()).slice(0, 200)}`);
  } else {
    const stores = ((await dsRes.json()) as { dataStores?: Record<string, unknown>[] }).dataStores ?? [];
    console.log(`${stores.length} data store(s):`);
    for (const ds of stores) {
      console.log(`  - ${String(ds.name).split('/').pop()}  "${ds.displayName}"  contentConfig=${ds.contentConfig}  vertical=${ds.industryVertical}  solutions=${JSON.stringify(ds.solutionTypes ?? [])}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
