import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';

const REASONING_ENGINE_ID = '2808809655537500160';
const PROJECT = '505103737920';
const LOCATION = 'us-central1';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);

  console.log('Sending: "Am I free tomorrow at 2pm?"\n');
  const result = await chatWithAdkAgent(PROJECT, saToken, {
    reasoningEngineId: REASONING_ENGINE_ID,
    message: 'Am I free tomorrow at 2pm?',
    userId: 'cf-diag-calendar-check',
    location: LOCATION,
  });
  console.log('=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
