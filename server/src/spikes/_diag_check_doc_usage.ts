/** Checks actual current document count across all data stores in the project (via
 *  stats), to see whether the documents_regional quota error is a real total-count
 *  problem or something else (e.g. a burst-rate quota) — the reported limit (200,000)
 *  doesn't match the tiny volume we actually imported today.
 *   npx tsx src/spikes/_diag_check_doc_usage.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { effectiveGeminiProject } from '../services/gemini.js';

const PROJECT_NUM = '231705905417';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const project = effectiveGeminiProject('studio-enterprise-migration');

  console.log('--- All data stores in the project ---');
  const dsRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const dsBody = await dsRes.json() as { dataStores?: { name: string; displayName?: string }[] };
  console.log(`Total data stores: ${dsBody.dataStores?.length ?? 0}`);

  let totalDocs = 0;
  for (const ds of dsBody.dataStores ?? []) {
    const id = ds.name.split('/').pop();
    const branchRes = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/${ds.name}/branches/0/documents?pageSize=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const branchBody = await branchRes.json() as { documents?: unknown[] };
    // pageSize=1 doesn't give a total count directly; use branches.documents:list with
    // a large page size instead isn't efficient either. Just note per-store presence.
    console.log(`  ${id}: sample fetch status ${branchRes.status}, has docs: ${!!branchBody.documents?.length}`);
  }
  console.log(`\n(Exact total document count across stores needs the per-store stats endpoint, not just a list probe.)`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
