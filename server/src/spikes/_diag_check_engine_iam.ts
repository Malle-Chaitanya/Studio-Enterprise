import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  const token = await getSaToken(impersonate);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const engineBase = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;

  const res = await fetch(`${engineBase}:getIamPolicy`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  console.log(`Engine-level :getIamPolicy -> ${res.status}`);
  console.log(await res.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
