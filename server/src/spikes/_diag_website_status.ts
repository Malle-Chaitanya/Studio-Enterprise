/**
 * Check whether a website data store's target site is ACTUALLY being indexed
 * (vs. just created/attached). Answers "is the data really preserved?" — reads
 * the target site's indexing + domain-verification status.
 *
 *   npx tsx src/spikes/_diag_website_status.ts [dataStoreId]   (default: cf-web-adv)
 *
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const DS = process.argv[2] || 'cf-web-adv';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);
  const collection = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection`;

  // Target sites + their indexing / verification status.
  console.log(`\n=== target sites for dataStore ${DS} ===`);
  const tsRes = await fetch(`${collection}/dataStores/${DS}/siteSearchEngine/targetSites`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!tsRes.ok) {
    console.log(`failed (${tsRes.status}): ${(await tsRes.text()).slice(0, 200)}`);
  } else {
    const sites = ((await tsRes.json()) as { targetSites?: Record<string, unknown>[] }).targetSites ?? [];
    for (const t of sites) {
      console.log(`\n  pattern: ${t.providedUriPattern}`);
      console.log(`  indexingStatus: ${t.indexingStatus ?? '(none)'}`);
      console.log(`  siteVerificationInfo: ${JSON.stringify(t.siteVerificationInfo ?? '(none)')}`);
      if (t.failureReason) console.log(`  failureReason: ${JSON.stringify(t.failureReason)}`);
    }
    if (!sites.length) console.log('  (no target sites)');
  }

  // How many documents have actually been indexed so far.
  console.log(`\n=== indexed documents in ${DS} ===`);
  const docRes = await fetch(`${collection}/dataStores/${DS}/branches/default_branch/documents?pageSize=5`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!docRes.ok) {
    console.log(`failed (${docRes.status}): ${(await docRes.text()).slice(0, 200)}`);
  } else {
    const docs = ((await docRes.json()) as { documents?: unknown[] }).documents ?? [];
    console.log(`${docs.length} document(s) returned (first page) — >0 means crawling has produced content.`);
  }

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
