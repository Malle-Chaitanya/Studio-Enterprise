/**
 * Test that the BigQuery "ensure" functions degrade gracefully (never throw)
 * when the credential can't actually use BigQuery — simulating what happens
 * on a real customer project that hasn't granted bigquery.dataEditor/jobUser.
 * Uses a deliberately invalid bearer token (401) rather than a real
 * under-privileged one (403) — different HTTP status, but exercises the
 * SAME code path: a non-ok fetch response handled as {ok:false, error},
 * never an unhandled throw.
 */
import { ensureBigQueryApiEnabled, ensureBqDataset, ensureBqTable, loadRowsToBqTable } from '../services/bigqueryUpload.js';

const BAD_TOKEN = 'invalid-token-simulating-no-bigquery-access';
const PROJECT = '231705905417';

async function main() {
  console.log('--- ensureBigQueryApiEnabled with bad token ---');
  try {
    const r1 = await ensureBigQueryApiEnabled(BAD_TOKEN, PROJECT);
    console.log('Result:', JSON.stringify(r1));
    console.log(r1.ok === false && typeof r1.error === 'string' ? '✅ graceful failure' : '❌ unexpected shape');
  } catch (e) {
    console.log('❌ THREW instead of returning gracefully:', (e as Error).message);
  }

  console.log('\n--- ensureBqDataset with bad token ---');
  try {
    const r2 = await ensureBqDataset(BAD_TOKEN, PROJECT, 'test_permcheck_dataset', 'US');
    console.log('Result:', JSON.stringify(r2));
    console.log(r2.ok === false && typeof r2.error === 'string' ? '✅ graceful failure' : '❌ unexpected shape');
  } catch (e) {
    console.log('❌ THREW instead of returning gracefully:', (e as Error).message);
  }

  console.log('\n--- ensureBqTable with bad token ---');
  try {
    const r3 = await ensureBqTable(BAD_TOKEN, PROJECT, 'test_permcheck_dataset', 'test_table', [{ name: 'id', type: 'STRING', mode: 'REQUIRED' }]);
    console.log('Result:', JSON.stringify(r3));
    console.log(r3.ok === false && typeof r3.error === 'string' ? '✅ graceful failure' : '❌ unexpected shape');
  } catch (e) {
    console.log('❌ THREW instead of returning gracefully:', (e as Error).message);
  }

  console.log('\n--- loadRowsToBqTable with bad token ---');
  try {
    const r4 = await loadRowsToBqTable(BAD_TOKEN, PROJECT, 'test_permcheck_dataset', 'test_table', [{ id: '1' }]);
    console.log('Result:', JSON.stringify(r4));
    console.log(r4.started === false && typeof r4.error === 'string' ? '✅ graceful failure' : '❌ unexpected shape');
  } catch (e) {
    console.log('❌ THREW instead of returning gracefully:', (e as Error).message);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('SPIKE ITSELF FAILED:', e.message); process.exit(1); });
