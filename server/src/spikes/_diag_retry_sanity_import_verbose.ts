// Re-runs the sanity-check file's GCS upload + import with verbose raw
// operation logging (createDataStore/bucket are idempotent, so this is safe
// to re-run) — to see exactly what Discovery Engine reports instead of
// guessing why the first attempt's reconciliation called it "unaccounted".
//   npx tsx src/spikes/_diag_retry_sanity_import_verbose.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { createDataStore, importDocumentsFromGcs, getOperation } from '../services/geminiDataStore.js';
import { ensureBucket, uploadBytesToGcs } from '../services/gcsUpload.js';

const PROJECT = '231705905417';
const AGENT_SOURCE_ID = 'adk-file-grounding-sanity-check';
const DATA_STORE_ID = 'adk-file-grounding-sanity-check-file-sanity-check-facts-txt';
const FILE_NAME = 'sanity-check-facts.txt';
const CONTENT =
  'SECRET TEST MARKER: ZX-CONFLICT-7742\n\n' +
  'The onetime migration Conflict Report can be generated with this exact MongoDB query:\n' +
  "db.migrationConflicts.find({ status: 'conflict', runType: 'onetime' })\n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const saToken = await getSaToken();

  console.log('createDataStore (idempotent)...');
  const ds = await createDataStore(PROJECT, saToken, {
    dataStoreId: DATA_STORE_ID,
    displayName: `${FILE_NAME} (ADK file grounding — ${AGENT_SOURCE_ID})`,
    kind: 'document',
  });
  console.log('  ->', JSON.stringify(ds));

  const bucket = process.env.ADK_STAGING_BUCKET || `${PROJECT}-adk-staging`;
  const bucketName = bucket.replace(/^gs:\/\//, '');
  console.log('ensureBucket...');
  const b = await ensureBucket(saToken, PROJECT, bucketName);
  console.log('  ->', JSON.stringify(b));

  const objectName = `knowledge-files/${AGENT_SOURCE_ID}/${FILE_NAME}`;
  console.log('uploadBytesToGcs...', objectName);
  const up = await uploadBytesToGcs(saToken, bucketName, objectName, Buffer.from(CONTENT, 'utf-8'), 'text/plain');
  console.log('  ->', JSON.stringify(up));
  if (!up.ok || !up.gcsUri) {
    console.log('GCS upload failed, stopping.');
    return;
  }

  console.log('importDocumentsFromGcs...', up.gcsUri);
  const imp = await importDocumentsFromGcs(PROJECT, saToken, DATA_STORE_ID, [up.gcsUri]);
  console.log('  ->', JSON.stringify(imp));
  if (!imp.started || !imp.operationName) {
    console.log('Import did not start, stopping.');
    return;
  }

  console.log('Polling operation with verbose raw output...');
  for (let i = 0; i < 24; i++) {
    const op = await getOperation(saToken, imp.operationName);
    console.log(`  poll ${i}:`, JSON.stringify(op, null, 2));
    if (op?.done) break;
    await sleep(5000);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
