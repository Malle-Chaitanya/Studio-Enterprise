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

  const dsName = `projects/${project}/locations/global/collections/default_collection/dataStores/cd560e08-8e90-f111-8077-0022480a981d-confluence`;
  const dsRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${dsName}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Data store config:', JSON.stringify(await dsRes.json(), null, 2).slice(0, 1000));

  const docsRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${dsName}/branches/0/documents?pageSize=1`, { headers: { Authorization: `Bearer ${token}` } });
  const docsBody = await docsRes.json() as { documents?: { name: string }[] };
  const doc = docsBody.documents?.[0];
  if (!doc) { console.log('no docs'); process.exit(0); }
  const chunksRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${doc.name}/chunks?pageSize=1000`, { headers: { Authorization: `Bearer ${token}` } });
  const chunksBody = await chunksRes.json() as { chunks?: unknown[] };
  console.log(`\nChunks for one document: status ${chunksRes.status}, count: ${chunksBody.chunks?.length ?? JSON.stringify(chunksBody).slice(0,300)}`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
