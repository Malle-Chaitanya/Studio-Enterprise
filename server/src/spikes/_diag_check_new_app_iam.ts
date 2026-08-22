import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const engineUrl = 'https://discoveryengine.googleapis.com/v1alpha/projects/231705905417/locations/global/collections/default_collection/engines/geminienterpriseapp_1787403755425';

  console.log('--- Engine-level IAM on the NEW app (GeminiEnterpriseApp) ---');
  const res = await fetch(`${engineUrl}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(res.status, await res.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
