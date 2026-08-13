/** The search tool fires cleanly with zero errors but returns empty results even for
 *  the broadest possible query. Rule "documents never actually got written" in or out
 *  by checking the data store's real document count directly (not through search).
 *  npx tsx src/spikes/_diag_check_datastore_doc_count.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const STORE_IDS = [
  'bdf9b817-9b90-f111-b8da-0022480b1f83-tbl-cr88d-cficpprofiles',
  'bdf9b817-9b90-f111-b8da-0022480b1f83-tbl-cr88d-faqentries',
];

async function main() {
  const saToken = await getSaToken('zara@storefuze.com');
  for (const storeId of STORE_IDS) {
    console.log(`\n=== ${storeId} ===`);
    // branches/default_branch/documents lists what's actually stored, regardless of
    // whether the search INDEX has caught up yet — this tells us "did the write
    // happen" independent of "is it searchable yet".
    const res = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${storeId}/branches/default_branch/documents?pageSize=5`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    console.log('  documents.list status:', res.status);
    const json = await res.json();
    const docs = (json as { documents?: unknown[] }).documents ?? [];
    console.log(`  ${docs.length} document(s) returned (page size 5)`);
    if (docs.length) console.log('  sample:', JSON.stringify(docs[0]).slice(0, 500));
    if (!docs.length) console.log('  raw response:', JSON.stringify(json).slice(0, 500));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
