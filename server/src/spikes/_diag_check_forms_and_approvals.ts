/**
 * Two checks before wiring:
 * 1. shared_microsoftforms — inspect its real captured paths (already in our DB) to see
 *    if there's a genuine mechanical vendor host, rather than just asserting "no API".
 * 2. shared_advancedapprovals — not in our 281-connector registry at all; live-capture it
 *    from the real environment to see its real operations/paths before deciding a base URL.
 *
 * Run: npx tsx src/spikes/_diag_check_forms_and_approvals.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { captureOpIndex } = await import('../connectors/captureOpIndex.js');

const CTX = {
  tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e',
  environmentId: '7f9f87cc-464e-e470-95bb-363b7f227200',
  scope: '6a5dfdff7cf05623332758b7',
};

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  console.log('=== shared_microsoftforms real captured paths ===');
  const formsOps = await db.collection('connectorOperations').find({ connectorId: 'shared_microsoftforms' }).toArray();
  console.log(`${formsOps.length} operations found in DB`);
  for (const o of formsOps) console.log(' ', o.method, o.path);
  const formsConn = await db.collection('connectors').findOne({ connectorId: 'shared_microsoftforms' });
  console.log('auth:', JSON.stringify(formsConn?.authParameters));

  console.log('\n=== shared_advancedapprovals live capture (not yet in registry) ===');
  const index = await captureOpIndex('shared_advancedapprovals', CTX);
  if (!index) {
    console.log('NOT CAPTURABLE from this environment (not installed here, or capture failed)');
  } else {
    console.log(`displayName: ${index.displayName}`);
    console.log(`proxyHost: ${index.proxyHost}`);
    console.log(`operationCount: ${index.operationCount}`);
    console.log('connectionAuth:', JSON.stringify(index.connectionAuth, null, 2));
    console.log('sample paths:');
    for (const [opId, op] of Object.entries(index.operations).slice(0, 10)) {
      console.log(' ', op.method, op.path, '  //', opId);
    }
  }

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
