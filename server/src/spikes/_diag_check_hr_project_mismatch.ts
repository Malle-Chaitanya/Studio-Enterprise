import 'dotenv/config';
import { getDb, connectDb } from '../db/core.js';
import { config } from '../config.js';
import { getSaToken } from '../auth/google.js';
import { verifyDocumentsIndexed } from '../services/geminiDataStore.js';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const hrSourceId = '48248234-cb90-f111-8077-0022480a981d';
  const deployments = await db.collection('adkDeployments').find({ sourceId: hrSourceId }).toArray();
  console.log('adkDeployments for HR agent:', JSON.stringify(deployments, null, 2));

  const saToken = await getSaToken();
  const indexedInRealProject = await verifyDocumentsIndexed('72860638029', saToken, '48248234-cb90-f111-8077-0022480a981d-file-neutara-hr-leave-poli');
  console.log('HR PDF actually indexed in project 72860638029:', indexedInRealProject);
}
main().catch((e) => console.error('FAILED:', e.message));
