import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { awaitImport } from '../services/geminiDataStore.js';

const OP_NAME = 'projects/231705905417/locations/global/collections/default_collection/dataStores/spiketest-natural-msefapld-tbl-systemusers/branches/0/operations/import-documents-7777451167947164483';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);
  const reconciled = await awaitImport(token, OP_NAME, 259, { maxPolls: 360, intervalMs: 5000 });
  console.log(JSON.stringify(reconciled, null, 2));
  console.log(reconciled.succeeded === 259 && reconciled.failed === 0 ? '\n✅ FIXED — correctly reconciles as fully succeeded.' : '\n❌ still wrong');
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(0); });
