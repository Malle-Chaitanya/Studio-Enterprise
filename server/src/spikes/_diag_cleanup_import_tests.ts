import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, effectiveGeminiProject } from '../services/gemini.js';
async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const project = effectiveGeminiProject(dest.project);
  for (const id of ['diag-raw-import-test', 'diag-real-failure-check-tbl-cr88d-faqentries']) {
    const res = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    console.log(id, res.status);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
