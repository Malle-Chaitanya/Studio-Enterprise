/**
 * Sanity-checks the "30 operations changed" result from _diag_verify_registry_refresh.ts:
 * is the diff logic (JSON.stringify comparison in connectorRegistryRefresh.ts) catching a
 * real spec difference, or a false positive from key/array ordering? Compares one specific
 * operation's stored parameters (post-refresh, i.e. the new live data) against what a
 * FRESH second live capture returns right now — these two should be identical since both
 * are "live" from the same environment moments apart. If they differ, the diff logic has a
 * false-positive problem; if identical, the "changed" flags were real (or artifacts of the
 * PRIOR stored copy predating a genuine upstream change, not of this comparison itself).
 *
 * Run: npx tsx src/spikes/_diag_check_dropbox_diff_reason.ts
 */
const { connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { captureOpIndex } = await import('../connectors/captureOpIndex.js');
const { listOperationsFor } = await import('../db/repos/connectorRegistry.js');

const CTX = {
  tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e',
  environmentId: '7f9f87cc-464e-e470-95bb-363b7f227200',
  scope: '6a5dfdff7cf05623332758b7',
};

async function main() {
  await connectDb(config.CSGE_DB);

  const stored = await listOperationsFor('shared_dropbox');
  const live = await captureOpIndex('shared_dropbox', CTX);
  if (!live) throw new Error('live capture failed');

  const op = 'ListFolder';
  const storedOp = stored.find((o) => o.operationId === op);
  const liveOp = live.operations[op];
  console.log('stored parameters:', JSON.stringify(storedOp?.parameters, null, 2));
  console.log('live   parameters:', JSON.stringify(liveOp?.parameters, null, 2));
  console.log('identical:', JSON.stringify(storedOp?.parameters) === JSON.stringify(liveOp?.parameters));

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
