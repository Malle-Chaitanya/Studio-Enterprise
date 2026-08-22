/** Corrected: right engine (old one, where KB-Grounding-Test-Agent actually lives), and
 *  trying the agent-path-scoped :assist variant since the bare assistant-level :assist with
 *  an agentId body field was rejected ("Unknown name agentId").
 *   npx tsx src/spikes/_diag_test_direct_reachability2.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '7284613592318946592'; // KB-Grounding-Test-Agent — agentUser=austin ONLY
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'gemini-enterprise-17847887_1784788734248', assistant: 'default_assistant' };

async function tryVariant(label: string, url: string, body: unknown, token: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`\n[${label}] ${res.status}`, (await res.text()).slice(0, 400));
}

async function probeAs(email: string) {
  const token = await getSaToken(email);
  console.log(`\n========== as ${email} ==========`);
  await tryVariant('agent-path :assist', `${assistantBase(dest)}/agents/${AGENT_ID}:assist`, { query: { text: 'Hello, what can you help with?' } }, token);
  await tryVariant('bare :assist w/ agentId', `${assistantBase(dest)}:assist`, { query: { text: 'Hello' }, session: '', agentId: AGENT_ID }, token);
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const adminToken = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  console.log('Confirming grant state:');
  const iam = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}:getIamPolicy`, { headers: { Authorization: `Bearer ${adminToken}` } });
  console.log(await iam.text());

  await probeAs('collins-gd@storefuze.com');
  await probeAs('austin@fuzebot.co');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
