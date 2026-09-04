import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';

const REASONING_ENGINE_ID = '1917096929318141952';
const PROJECT = '505103737920';
const LOCATION = 'us-central1';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);

  const msg = 'Schedule a call with alex@migrationn.com on September 1st 2026 from 9:00 AM to 10:00 AM titled Agents Sync';
  console.log(`Sending: "${msg}"\n`);
  const result = await chatWithAdkAgent(PROJECT, saToken, {
    reasoningEngineId: REASONING_ENGINE_ID,
    message: msg,
    userId: 'cf-diag-calendar-auth-raw',
    location: LOCATION,
  });
  console.log('=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
