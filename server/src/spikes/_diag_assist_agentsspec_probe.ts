import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

const PROJECT = '231705905417';
const TEST_AGENT_ID = '17029706317273213140';
const PROBE = 'What is the secret_code value for the contact named Zzqcheck Testperson842?';

async function tryShape(label: string, body: unknown, token: string, url: string) {
  console.log('\n' + '='.repeat(70));
  console.log(label);
  console.log(JSON.stringify(body));
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`status: ${res.status}`);
  console.log(text.slice(0, 800));
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);
  const dest = await resolveDestination(PROJECT, token);
  const agentResourceName = `projects/${PROJECT}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents/${TEST_AGENT_ID}`;
  const url = `${assistantBase(dest)}:assist`;

  await tryShape('Shape 1: agentsSpec.agentSpecs[].agent', { query: { text: PROBE }, agentsSpec: { agentSpecs: [{ agent: agentResourceName }] } }, token, url);
  await tryShape('Shape 2: agentsSpec.agentSpec.agent (singular)', { query: { text: PROBE }, agentsSpec: { agentSpec: { agent: agentResourceName } } }, token, url);
  await tryShape('Shape 3: agentsSpec.agents[] (plain strings)', { query: { text: PROBE }, agentsSpec: { agents: [agentResourceName] } }, token, url);
  await tryShape('Shape 4: agentsSpec empty object (see what it complains is missing)', { query: { text: PROBE }, agentsSpec: {} }, token, url);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(0); });
