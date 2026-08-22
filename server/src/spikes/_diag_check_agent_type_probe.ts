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
  const res = await fetch(`${base}/agents/14307800153025157875`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  console.log(JSON.stringify({ state: j.state, hasLowCode: !!j.lowCodeAgentDefinition, hasAdk: !!j.adkAgentDefinition, sharingConfig: j.sharingConfig, activeRevision: j.activeRevision }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
