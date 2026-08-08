import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from '../services/graphFiles.js';
import { createDataStore, importDocumentsFromGcs, getOperation } from '../services/geminiDataStore.js';
import { uploadBytesToGcs, ensureBucket } from '../services/gcsUpload.js';

const PROJECT = '231705905417';
const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const URL = 'https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt';

async function main() {
  const saToken = await getSaToken();
  const graphToken = await clientCredsToken(TENANT_ID, 'https://graph.microsoft.com');
  const resolved = await resolveShareUrlSmart(graphToken, URL);
  if (!resolved.item) throw new Error('could not resolve file');
  const bytes = await downloadDriveItemBytes(graphToken, resolved.item);
  if (!bytes) throw new Error('download failed');
  console.log('downloaded', bytes.bytes.length, 'bytes, contentType:', bytes.contentType);

  const dataStoreId = `ee2ea155-test-reimport-${Date.now().toString(36)}`;
  const created = await createDataStore(PROJECT, saToken, {
    dataStoreId,
    displayName: 'reimport test',
    kind: 'document',
  });
  console.log('create:', JSON.stringify(created));

  const bucket = `${PROJECT}-adk-staging`;
  await ensureBucket(saToken, PROJECT, bucket);
  const objectName = `knowledge-files/test-reimport/daily_queries.txt`;
  const up = await uploadBytesToGcs(saToken, bucket, objectName, bytes.bytes, bytes.contentType || 'text/plain');
  console.log('gcs upload:', JSON.stringify(up));

  const imp = await importDocumentsFromGcs(PROJECT, saToken, dataStoreId, [up.gcsUri!]);
  console.log('import started:', JSON.stringify(imp));

  // Poll manually with full detail, up to 2 minutes
  for (let i = 0; i < 24; i++) {
    const op = await getOperation(saToken, imp.operationName!);
    console.log(`poll ${i}:`, JSON.stringify(op));
    if (op?.done) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
main().catch((e) => console.error('FAILED:', e.message));
