/**
 * Live end-to-end sanity check: Dataverse-shaped row -> BigQuery table ->
 * Discovery Engine STRUCTURED data store (imported FROM BigQuery, not inline)
 * -> attach to the real test engine -> ask an existing test agent a question
 * that can only be answered from that row.
 *
 * Throwaway: dataset/table/data-store ids are all prefixed csge_bq_sanity_test
 * so they're trivial to find and delete afterward. Uses the same
 * DWD-impersonated service-account token as the rest of the app.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';
import { createDataStore, attachDataStoreToEngine, getOperation } from '../services/geminiDataStore.js';

const PROJECT = '231705905417';
const TEST_AGENT_ID = '17029706317273213140'; // "Migration Test Agent 1"
const DATASET_ID = 'csge_bq_sanity_test';
const TABLE_ID = 'contacts_snapshot';
const DATA_STORE_ID = 'csge-bq-sanity-test';
const SECRET_CODE = 'BQPIPE-4471-XQ'; // distinctive, unguessable — proves retrieval, not coincidence

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bq(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = s?.gEmail || undefined;
  const token = await getSaToken(impersonate);
  const dest = await resolveDestination(PROJECT, token);
  console.log(`Destination engine: ${dest.engine}\n`);

  // 1. Create BigQuery dataset (idempotent — ignore "already exists")
  console.log('[1/6] Creating BigQuery dataset...');
  const dsCreate = await bq(token, `projects/${PROJECT}/datasets`, {
    method: 'POST',
    body: JSON.stringify({ datasetReference: { projectId: PROJECT, datasetId: DATASET_ID }, location: 'US' }),
  });
  console.log(`  -> ${dsCreate.status}${dsCreate.ok ? '' : ' ' + dsCreate.text.slice(0, 200)}`);

  // 2. Create table with an explicit schema (plain typed columns, no jsonData wrapping)
  console.log('[2/6] Creating BigQuery table...');
  const tblCreate = await bq(token, `projects/${PROJECT}/datasets/${DATASET_ID}/tables`, {
    method: 'POST',
    body: JSON.stringify({
      tableReference: { projectId: PROJECT, datasetId: DATASET_ID, tableId: TABLE_ID },
      schema: {
        fields: [
          { name: 'id', type: 'STRING', mode: 'REQUIRED' },
          { name: 'full_name', type: 'STRING' },
          { name: 'email', type: 'STRING' },
          { name: 'secret_code', type: 'STRING' },
        ],
      },
    }),
  });
  console.log(`  -> ${tblCreate.status}${tblCreate.ok ? '' : ' ' + tblCreate.text.slice(0, 200)}`);

  // 3. Insert one distinctive fake row via a load job (avoids streaming-buffer lag)
  console.log('[3/6] Loading one row via BigQuery load job...');
  const row = { id: 'test-contact-001', full_name: 'Zzqcheck Testperson842', email: 'zzqcheck842@example-test.invalid', secret_code: SECRET_CODE };
  const ndjson = JSON.stringify(row);
  const boundary = 'csge_boundary_' + Date.now();
  const metadata = {
    configuration: {
      load: {
        destinationTable: { projectId: PROJECT, datasetId: DATASET_ID, tableId: TABLE_ID },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
      },
    },
  };
  const multipartBody =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${ndjson}\r\n--${boundary}--`;
  const loadRes = await fetch(
    `https://www.googleapis.com/upload/bigquery/v2/projects/${PROJECT}/jobs?uploadType=multipart`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipartBody },
  );
  const loadJson = (await loadRes.json()) as { jobReference?: { jobId?: string } };
  console.log(`  -> ${loadRes.status} job=${loadJson.jobReference?.jobId ?? '?'}`);
  const jobId = loadJson.jobReference?.jobId;
  if (jobId) {
    for (let i = 0; i < 20; i++) {
      const jobRes = await bq(token, `projects/${PROJECT}/jobs/${jobId}`);
      const state = jobRes.json?.status?.state;
      if (state === 'DONE') {
        console.log(`  load job DONE${jobRes.json?.status?.errorResult ? ' with ERROR: ' + JSON.stringify(jobRes.json.status.errorResult) : ' — OK'}`);
        break;
      }
      await sleep(2000);
    }
  }

  // 4. Create the Discovery Engine structured data store (idempotent)
  console.log('[4/6] Creating Discovery Engine structured data store...');
  const dsCreated = await createDataStore(PROJECT, token, {
    dataStoreId: DATA_STORE_ID,
    displayName: 'CSGE BigQuery sanity test (throwaway)',
    kind: 'structured',
  });
  console.log(`  -> created=${dsCreated.created} alreadyExists=${dsCreated.alreadyExists ?? false} error=${dsCreated.error ?? 'none'}`);

  // 5. Import documents FROM BigQuery (not inline) — the actual thing being tested
  console.log('[5/6] Importing documents from BigQuery into the data store...');
  const branch = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/default_branch`;
  const importRes = await fetch(`${branch}/documents:import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bigquerySource: { projectId: PROJECT, datasetId: DATASET_ID, tableId: TABLE_ID, dataSchema: 'custom' },
      reconciliationMode: 'FULL',
      autoGenerateIds: false,
      idField: 'id',
    }),
  });
  const importText = await importRes.text();
  console.log(`  -> ${importRes.status} ${importText.slice(0, 300)}`);
  const opName = importRes.ok ? JSON.parse(importText).name : undefined;
  if (opName) {
    for (let i = 0; i < 30; i++) {
      const op = await getOperation(token, opName);
      if (op?.done) {
        console.log(`  import operation DONE: ${JSON.stringify(op).slice(0, 400)}`);
        break;
      }
      await sleep(3000);
    }
  }

  // 6. Attach to the shared test engine
  console.log('[6/6] Attaching data store to engine...');
  const attach = await attachDataStoreToEngine(dest, token, DATA_STORE_ID);
  console.log(`  -> ok=${attach.ok} error=${attach.error ?? 'none'}`);

  // 7. Ask the test agent the one question only this row answers
  console.log('\n--- Querying "Migration Test Agent 1" ---');
  await sleep(5000); // brief settle time before querying
  const assistUrl = `${assistantBase(dest)}:assist`;
  const question = 'What is the secret_code value for the contact named Zzqcheck Testperson842? Search your knowledge sources.';
  const assistRes = await fetch(assistUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: question }, agentId: TEST_AGENT_ID }),
  });
  const assistText = await assistRes.text();
  console.log(`assist status: ${assistRes.status}`);
  console.log(assistText.slice(0, 3000));
  console.log(`\nExpected secret code: ${SECRET_CODE}`);
  console.log(assistText.includes(SECRET_CODE) ? '\n✅ FOUND the secret code in the response — retrieval WORKS.' : '\n❌ Secret code NOT found in response text — see raw output above.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
