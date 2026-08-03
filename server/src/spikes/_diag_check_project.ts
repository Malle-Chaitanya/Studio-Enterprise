import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { agentResourcePath } from '../services/geminiAgentFiles.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  console.log('geminiProject:', s?.geminiProject);
  if (!s?.geminiProject) process.exit(0);
  const dest = defaultDestination(s.geminiProject);
  console.log('dest:', dest);
  const path = agentResourcePath(dest, '4173300091433252924');
  console.log('resource path:', path);

  const saToken = await getSaToken(s.gEmail);
  const res = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${path}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log('direct getAgent status:', res.status);
  console.log((await res.text()).slice(0, 500));
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
