import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { getAgent } from '../services/geminiAgentFiles.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session/project');
  const dest = defaultDestination(s.geminiProject);
  const saToken = await getSaToken(s.gEmail);
  const agent = await getAgent(dest, saToken, '11544519672344204834');
  console.log('getAgent result:', JSON.stringify(agent, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
