/** THE actual remaining open question: does a person with baseline license + engine role
 *  but ZERO per-agent grant get blocked from directly querying a restricted ADK agent
 *  (real consumer-app assist endpoint, same one verify.ts uses) — or does state:ENABLED
 *  alone let them through regardless of grants, the way Email Manager Outlook did?
 *
 *  KB-Grounding-Test-Agent has agentUser=austin ONLY (confirmed earlier) — not org-wide,
 *  not shared with collins. Testing as BOTH collins (no grant) and austin (has grant),
 *  impersonating each via DWD, hitting the real :assist endpoint verify.ts uses.
 *   npx tsx src/spikes/_diag_test_direct_reachability.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '7284613592318946592'; // KB-Grounding-Test-Agent
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };

async function probeAs(email: string) {
  const token = await getSaToken(email);
  const assistUrl = `${assistantBase(dest)}:assist`;
  const res = await fetch(assistUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: 'Hello, what can you help with?' }, agentId: AGENT_ID }),
  });
  const text = await res.text();
  console.log(`\n=== as ${email} ===`);
  console.log(res.status, text.slice(0, 500));
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  console.log('Confirming KB-Grounding-Test-Agent grant state first (should be austin ONLY, no collins, no ALL_USERS):');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const iam = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(await iam.text());

  await probeAs('collins-gd@storefuze.com'); // NO grant on this agent
  await probeAs('austin@fuzebot.co'); // HAS the grant
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
