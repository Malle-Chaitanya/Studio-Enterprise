/**
 * Verifies the two behaviors the testing-standard.md rule requires for any
 * create/upload path: (1) best-effort persistence degrades instead of
 * crashing when Mongo isn't connected, and (2) idempotency — re-running setup
 * for the same (appUserId, kind, siteUrl) updates in place, never duplicates.
 * Pure DB-repo test, no live Google credentials needed.
 *   npx tsx src/spikes/_test_connector_repo.ts
 */
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import {
  getKnowledgeConnector,
  listKnowledgeConnectors,
  upsertKnowledgeConnector,
  markKnowledgeConnectorStatus,
} from '../db/repos/knowledgeConnectors.js';
import { getEntraAppCredential, upsertEntraAppCredential } from '../db/repos/entraAppCredentials.js';

const TEST_USER = 'zz-test-connector-repo';
const TEST_SITE = 'https://zz-test.sharepoint.com/sites/diagnostic';

async function assert(label: string, cond: boolean): Promise<void> {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  // ── 1. Mongo-down: before connectMongo() runs, isDbConnected() is false —
  //    every repo call must return null/[]/void, never throw. ────────────────
  const beforeConnect = await getKnowledgeConnector(TEST_USER, 'sharepoint', TEST_SITE).catch((e) => e);
  await assert('getKnowledgeConnector returns null (not throw) when DB unreachable', beforeConnect === null);

  const listBeforeConnect = await listKnowledgeConnectors(TEST_USER).catch((e) => e);
  await assert('listKnowledgeConnectors returns [] (not throw) when DB unreachable', Array.isArray(listBeforeConnect) && listBeforeConnect.length === 0);

  await upsertKnowledgeConnector({
    appUserId: TEST_USER, kind: 'sharepoint', siteUrl: TEST_SITE,
    collectionId: 'zz-test-coll', tenantId: 't1', clientId: 'c1', status: 'pending',
  }).catch((e) => { throw new Error(`upsertKnowledgeConnector threw when DB unreachable: ${e.message}`); });
  console.log('PASS — upsertKnowledgeConnector did not throw when DB unreachable');

  const credBeforeConnect = await getEntraAppCredential(TEST_USER, 't1').catch((e) => e);
  await assert('getEntraAppCredential returns null (not throw) when DB unreachable', credBeforeConnect === null);

  // ── 2. Connect to the real local Mongo and test idempotency ────────────────
  await connectMongo();

  // Clean slate for this test's scope only.
  await getDb().collection('knowledgeConnectors').deleteMany({ appUserId: TEST_USER });
  await getDb().collection('entraAppCredentials').deleteMany({ appUserId: TEST_USER });

  await upsertKnowledgeConnector({
    appUserId: TEST_USER, kind: 'sharepoint', siteUrl: TEST_SITE,
    collectionId: 'zz-test-coll', tenantId: 't1', clientId: 'c1', operationName: 'op1', status: 'pending',
  });
  await upsertKnowledgeConnector({
    // Re-run for the SAME site — must update in place, not duplicate.
    appUserId: TEST_USER, kind: 'sharepoint', siteUrl: TEST_SITE,
    collectionId: 'zz-test-coll', tenantId: 't1', clientId: 'c1', operationName: 'op2', status: 'pending',
  });
  const count = await getDb().collection('knowledgeConnectors').countDocuments({ appUserId: TEST_USER, kind: 'sharepoint', siteUrl: TEST_SITE });
  await assert('re-running setup for the same site upserts in place (exactly 1 row)', count === 1);

  const row = await getKnowledgeConnector(TEST_USER, 'sharepoint', TEST_SITE);
  await assert('the upserted row reflects the SECOND call (operationName op2)', row?.operationName === 'op2');

  await markKnowledgeConnectorStatus(TEST_USER, 'sharepoint', TEST_SITE, { status: 'done', dataStoreIds: ['ds1'] });
  const updated = await getKnowledgeConnector(TEST_USER, 'sharepoint', TEST_SITE);
  await assert('markKnowledgeConnectorStatus patches status + dataStoreIds', updated?.status === 'done' && updated?.dataStoreIds?.[0] === 'ds1');

  // entraAppCredentials: same upsert-in-place check, scoped by (appUserId, tenantId).
  await upsertEntraAppCredential(TEST_USER, 't1', 'clientA', 'projects/p/secrets/s/versions/1');
  await upsertEntraAppCredential(TEST_USER, 't1', 'clientA', 'projects/p/secrets/s/versions/2');
  const credCount = await getDb().collection('entraAppCredentials').countDocuments({ appUserId: TEST_USER, tenantId: 't1' });
  await assert('re-onboarding the same tenant upserts in place (exactly 1 row)', credCount === 1);
  const cred = await getEntraAppCredential(TEST_USER, 't1');
  await assert('the upserted credential reflects the SECOND version', cred?.secretName === 'projects/p/secrets/s/versions/2');

  // Cleanup.
  await getDb().collection('knowledgeConnectors').deleteMany({ appUserId: TEST_USER });
  await getDb().collection('entraAppCredentials').deleteMany({ appUserId: TEST_USER });

  process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
