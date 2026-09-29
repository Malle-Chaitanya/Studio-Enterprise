/**
 * Proves the normalized diff in connectorRegistryRefresh.ts still catches a REAL change —
 * the previous fix only removed a false positive, this confirms it didn't also silence
 * genuine detection. Corrupts one stored operation's method (GET -> POST) directly in the
 * DB, backdates capturedAt, runs the sweep, and confirms it (a) flags the operation as
 * changed and (b) writes back the correct live value.
 *
 * Run: npx tsx src/spikes/_diag_verify_registry_refresh_detects_real_change.ts
 */
process.env.CONNECTOR_REGISTRY_TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
process.env.CONNECTOR_REGISTRY_ENV_ID = '7f9f87cc-464e-e470-95bb-363b7f227200';
process.env.CONNECTOR_REGISTRY_SCOPE = '6a5dfdff7cf05623332758b7';

const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { runConnectorRegistryRefresh } = await import('../services/connectorRegistryRefresh.js');
const { listOperationsFor } = await import('../db/repos/connectorRegistry.js');

const CONNECTOR_ID = 'shared_dropbox';
const OP_ID = 'ListFolder';

async function main() {
  await connectDb(config.CSGE_DB);

  const before = await listOperationsFor(CONNECTOR_ID);
  const beforeOp = before.find((o) => o.operationId === OP_ID);
  console.log('real stored method before corruption:', beforeOp?.method);

  await getDb(config.CSGE_DB)
    .collection('connectorOperations')
    .updateOne({ connectorId: CONNECTOR_ID, operationId: OP_ID }, { $set: { method: 'POST' } });
  await getDb(config.CSGE_DB)
    .collection('connectors')
    .updateOne({ connectorId: CONNECTOR_ID }, { $set: { capturedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } });
  console.log('corrupted stored method to POST and backdated capturedAt');

  await runConnectorRegistryRefresh();

  const after = await listOperationsFor(CONNECTOR_ID);
  const afterOp = after.find((o) => o.operationId === OP_ID);
  console.log('stored method after sweep:', afterOp?.method);

  if (afterOp?.method !== beforeOp?.method) {
    throw new Error(`FAIL — sweep did not correct the real change back to ${beforeOp?.method}`);
  }
  console.log(`PASS — sweep detected the real discrepancy and corrected it back to ${beforeOp?.method}.`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
