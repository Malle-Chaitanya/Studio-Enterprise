/**
 * Prove the attachDataStoreToEngine API call actually works: attach the
 * manually-created "manual-website-test" data store to the real
 * agentspace-engine, using the current session's service-account credentials.
 *
 *   npx tsx src/_diag_attach_manual_store.ts manual-website-test_1785483048153
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { attachDataStoreToEngine } from '../services/geminiDataStore.js';

const DATA_STORE_ID = process.argv[2];
if (!DATA_STORE_ID) throw new Error('usage: _diag_attach_manual_store.ts <dataStoreId>');

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');

  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);

  console.log(`project: ${dest.project}\nengine: ${dest.engine}\ndataStoreId: ${DATA_STORE_ID}\n`);
  console.log('attaching...');
  const result = await attachDataStoreToEngine(dest, saToken, DATA_STORE_ID);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
