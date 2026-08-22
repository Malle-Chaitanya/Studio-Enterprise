/** READ-ONLY. Checks whether documents:list returns a total-size field directly
 *  (avoiding full pagination), for each data store, to find which ones actually hold
 *  the bulk of the 888,004 documents before considering deleting anything.
 *   npx tsx src/spikes/_diag_check_store_totals.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { effectiveGeminiProject } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const project = effectiveGeminiProject('studio-enterprise-migration');

  const dsRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const dsBody = await dsRes.json() as { dataStores?: { name: string }[] };

  for (const ds of dsBody.dataStores ?? []) {
    const id = ds.name.split('/').pop();
    const res = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${ds.name}/branches/0/documents?pageSize=1000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as { documents?: unknown[]; nextPageToken?: string; totalSize?: number };
    const shown = body.documents?.length ?? 0;
    const more = body.nextPageToken ? '+ (more pages exist)' : '';
    console.log(`${id}: ${shown}${more}  totalSize field: ${body.totalSize ?? '(not returned)'}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
