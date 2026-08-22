import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  const token = await getSaToken(impersonate);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const base = assistantBase(dest);
  const agentId = '11138074654162485859'; // "A" / CloudFuze Migration Advisor

  const agentRes = await fetch(`${base}/agents/${agentId}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Raw agent body:');
  console.log(await agentRes.text());

  const iamRes = await fetch(`${base}/agents/${agentId}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`\nPer-agent :getIamPolicy -> ${iamRes.status}`);
  console.log(await iamRes.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
