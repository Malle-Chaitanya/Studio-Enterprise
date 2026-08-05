import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

const PROJECT = '231705905417';
const TEST_AGENT_ID = '17029706317273213140';
const PROBE = 'What is the secret_code value for the contact named Zzqcheck Testperson842?';

async function tryShape(label: string, url: string, body: unknown, token: string) {
  console.log('\n' + '='.repeat(70));
  console.log(label);
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`status: ${res.status}`);
  console.log(text.slice(0, 1500));
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);
  const dest = await resolveDestination(PROJECT, token);
  const agentResourceName = `projects/${PROJECT}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents/${TEST_AGENT_ID}`;
  const assistUrl = `${assistantBase(dest)}:assist`;

  await tryShape('Shape B: top-level "agent" full resource name', assistUrl, { query: { text: PROBE }, agent: agentResourceName }, token);
  await tryShape('Shape D: agentsConfig.agent', assistUrl, { query: { text: PROBE }, agentsConfig: { agent: agentResourceName } }, token);
  await tryShape('Shape E: session-scoped path (assistants/.../agents/{id}:assist)', `${assistantBase(dest)}/agents/${TEST_AGENT_ID}:assist`, { query: { text: PROBE } }, token);
  await tryShape('Shape F: no agent field (plain default assistant, sees ALL attached data stores)', assistUrl, { query: { text: PROBE } }, token);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(0); });
