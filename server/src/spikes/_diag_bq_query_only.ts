import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

const PROJECT = '231705905417';
const TEST_AGENT_ID = '17029706317273213140'; // "Migration Test Agent 1"
const SECRET_CODE = 'BQPIPE-4471-XQ';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);
  const dest = await resolveDestination(PROJECT, token);
  const agentResourceName = `projects/${PROJECT}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents/${TEST_AGENT_ID}`;

  const assistUrl = `${assistantBase(dest)}:assist`;
  const body = {
    query: { text: 'What is the secret_code value for the contact named Zzqcheck Testperson842? Search your knowledge sources and answer with just the code.' },
    toolsSpec: { agentspaceAgentConfig: { agent: agentResourceName } },
  };
  console.log('POST', assistUrl);
  console.log('body:', JSON.stringify(body));
  const res = await fetch(assistUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log('\nstatus:', res.status);
  console.log(text.slice(0, 4000));
  console.log(`\nExpected secret code: ${SECRET_CODE}`);
  console.log(text.includes(SECRET_CODE) ? '\n✅ FOUND the secret code — retrieval WORKS.' : '\n❌ Secret code NOT found in response text.');
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
