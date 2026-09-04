import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const SECRET_ID = 'studio-enterprise-6a5dfdff7cf05623332758b7-shared-googlecalendar-service-account-json';
const CANDIDATE_PROJECTS = ['505103737920', 'agentmigrations'];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  console.log('session.geminiProject:', s?.geminiProject);
  const saToken = await getSaToken(s?.gEmail || undefined);

  for (const project of CANDIDATE_PROJECTS) {
    console.log(`\n--- project: ${project} ---`);
    const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${SECRET_ID}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
    console.log(`GET secret: HTTP ${res.status}`);
    if (res.ok) {
      console.log(await res.text());
      // Check versions too
      const vRes = await fetch(`${url}/versions`, { headers: { Authorization: `Bearer ${saToken}` } });
      console.log(`GET versions: HTTP ${vRes.status}`);
      console.log(await vRes.text());
      // Check IAM policy
      const iamRes = await fetch(`${url}:getIamPolicy`, { headers: { Authorization: `Bearer ${saToken}` } });
      console.log(`GET IAM policy: HTTP ${iamRes.status}`);
      console.log(await iamRes.text());
    } else {
      console.log(await res.text());
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
