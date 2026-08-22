import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { publishAgent, grantAgentAccess, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '3299875621167969112';
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };

function agentUrl(id: string) {
  return `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents/${id}`;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  console.log('--- BEFORE ---');
  const before = await fetch(agentUrl(AGENT_ID), { headers: { Authorization: `Bearer ${token}` } });
  const beforeBody = await before.json() as any;
  console.log(before.status, 'state:', beforeBody.state, 'draftPublishState/activeRevision:', beforeBody.activeRevision, 'lowCode keys:', Object.keys(beforeBody.lowCodeAgentDefinition ?? {}));

  console.log('\n--- Publishing ---');
  const published = await publishAgent(dest, token, AGENT_ID);
  console.log('publishAgent() ->', published);

  console.log('\n--- AFTER publish ---');
  const after = await fetch(agentUrl(AGENT_ID), { headers: { Authorization: `Bearer ${token}` } });
  const afterBody = await after.json() as any;
  console.log(after.status, 'state:', afterBody.state, 'activeRevision:', afterBody.activeRevision);

  console.log('\n--- Retrying grantAgentAccess after publish ---');
  const grant = await grantAgentAccess(dest, token, AGENT_ID, { users: ['austin@fuzebot.co'], groups: [] });
  console.log(JSON.stringify(grant, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
