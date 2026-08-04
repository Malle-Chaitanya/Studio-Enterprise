import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';

const AGENT_ID = '7261538344381084733';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session/project');
  const dest = defaultDestination(s.geminiProject);
  const saToken = await getSaToken(s.gEmail);
  const agent = await getAgent(dest, saToken, AGENT_ID);
  console.log('RAW agent object:');
  console.log(JSON.stringify(agent, null, 2));
  console.log('\nreadAgentFiles() sees:');
  console.log(JSON.stringify(readAgentFiles(agent), null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
