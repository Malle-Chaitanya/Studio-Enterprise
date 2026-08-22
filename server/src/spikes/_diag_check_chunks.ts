/** READ-ONLY. Tests the chunking hypothesis directly: pick one real document from one
 *  of the larger data stores and check how many chunks it was actually split into.
 *   npx tsx src/spikes/_diag_check_chunks.ts */
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

  const dsName = `projects/${project}/locations/global/collections/default_collection/dataStores/124794af-3b8f-f111-b8da-0022480b1f83-tbl-cr88d-cf-icps`;
  const docsRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${dsName}/branches/0/documents?pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const docsBody = await docsRes.json() as { documents?: { name: string; id: string }[] };
  const doc = docsBody.documents?.[0];
  console.log('Sample document:', JSON.stringify(doc, null, 2).slice(0, 500));
  if (!doc) { process.exit(0); }

  const chunksRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${doc.name}/chunks?pageSize=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const chunksBody = await chunksRes.json();
  console.log('\nChunks response:', chunksRes.status, JSON.stringify(chunksBody, null, 2).slice(0, 1500));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
