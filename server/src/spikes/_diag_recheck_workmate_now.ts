import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '8561021016517220454';
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const agentUrl = `${assistantBase(dest)}/agents/${AGENT_ID}`;
  const iam = await fetch(`${agentUrl}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('RIGHT NOW, IAM policy:', await iam.text());
  const body = await fetch(agentUrl, { headers: { Authorization: `Bearer ${token}` } });
  const bodyJson = await body.json() as any;
  console.log('RIGHT NOW, sharingConfig:', JSON.stringify(bodyJson.sharingConfig));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
