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

  for (const [label, agentId] of [
    ['Email Manager (Outlook) - ENABLED', '5654538465772525334'],
    ['HubSpot Agent - ENABLED', '5539949030633558392'],
  ] as const) {
    const res = await fetch(`${base}/agents/${agentId}`, { headers: { Authorization: `Bearer ${token}` } });
    const raw = await res.text();
    console.log(`\n=== ${label} (${agentId}) — raw body ===`);
    console.log(raw);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
