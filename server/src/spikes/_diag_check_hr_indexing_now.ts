import 'dotenv/config';
import { getDb, connectDb } from '../db/core.js';
import { config } from '../config.js';
import { getSaToken } from '../auth/google.js';
import { verifyDocumentsIndexed } from '../services/geminiDataStore.js';

const PROJECT = '231705905417';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const rows = await db.collection('adkKnowledgeStores').find({}).toArray();
  console.log('adkKnowledgeStores rows:', JSON.stringify(rows, null, 2));

  const saToken = await getSaToken();
  for (const r of rows as any[]) {
    if (!r.dataStoreId) continue;
    const indexed = await verifyDocumentsIndexed(PROJECT, saToken, r.dataStoreId);
    console.log(`${r.fileName} (${r.dataStoreId}): status=${r.status}, actually indexed now = ${indexed}`);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
