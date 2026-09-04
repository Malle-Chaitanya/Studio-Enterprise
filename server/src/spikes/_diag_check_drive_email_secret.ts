import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import type { Session } from '../sessionStore.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);
  const project = '505103737920';
  const secretId = 'studio-enterprise-6a5dfdff7cf05623332758b7-shared-googledrive-impersonate-email';

  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
