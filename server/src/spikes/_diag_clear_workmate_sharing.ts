import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '8561021016517220454';
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };
const agentUrl = `${assistantBase(dest)}/agents/${AGENT_ID}`;

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  for (const attempt of [
    { label: 'empty sharingConfig object', body: { sharingConfig: {} } },
    { label: 'scope: SCOPE_UNSPECIFIED', body: { sharingConfig: { scope: 'SCOPE_UNSPECIFIED' } } },
  ]) {
    const res = await fetch(`${agentUrl}?updateMask=sharingConfig`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(attempt.body),
    });
    console.log(`\n[${attempt.label}] ${res.status}`, (await res.text()).slice(0, 300));
    if (res.ok) break;
  }

  console.log('\n--- Final state ---');
  const after = await fetch(agentUrl, { headers: { Authorization: `Bearer ${token}` } });
  const afterBody = await after.json() as any;
  console.log('sharingConfig:', JSON.stringify(afterBody.sharingConfig ?? '(unset)'));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
