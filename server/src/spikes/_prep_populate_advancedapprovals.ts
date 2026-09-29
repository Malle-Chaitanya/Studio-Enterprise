/**
 * Populates shared_advancedapprovals ("Human review") into the DB registry — the one
 * connector on Sales Profiler Agent that wasn't captured at all yet.
 *
 * Run: npx tsx src/spikes/_prep_populate_advancedapprovals.ts
 */
const { connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { captureOpIndex } = await import('../connectors/captureOpIndex.js');
const { putConnector, putConnectorOperations, toRegistryRecords } = await import('../db/repos/connectorRegistry.js');

const CTX = {
  tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e',
  environmentId: '7f9f87cc-464e-e470-95bb-363b7f227200',
  scope: '6a5dfdff7cf05623332758b7',
};

async function main() {
  await connectDb(config.CSGE_DB);

  const index = await captureOpIndex('shared_advancedapprovals', CTX);
  if (!index) throw new Error('capture failed');

  const { connector, operations } = toRegistryRecords(
    'shared_advancedapprovals',
    'Microsoft',
    true,
    'productivity',
    index,
  );
  await putConnector(connector);
  await putConnectorOperations('shared_advancedapprovals', operations);
  console.log(`Captured and stored shared_advancedapprovals: ${operations.length} operations`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
