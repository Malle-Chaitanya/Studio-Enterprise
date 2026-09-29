/**
 * Proves the connector-registry freshness sweep (services/connectorRegistryRefresh.ts)
 * actually works end-to-end against real data, not just typechecks:
 *
 *   1. Backdate one real, already-captured connector's `capturedAt` so it looks stale.
 *   2. Set the CONNECTOR_REGISTRY_* env vars (must happen before importing config, hence
 *      the dynamic imports below) so the sweep is "configured".
 *   3. Run the sweep for real — it must pick up the backdated connector, live-recapture
 *      it from the real reference environment, diff it against what was stored, and
 *      either update it or (if nothing changed) just bump capturedAt.
 *   4. Read the connector back and confirm capturedAt actually moved forward.
 *
 * Run: npx tsx src/spikes/_diag_verify_registry_refresh.ts
 */
process.env.CONNECTOR_REGISTRY_TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
process.env.CONNECTOR_REGISTRY_ENV_ID = '7f9f87cc-464e-e470-95bb-363b7f227200';
process.env.CONNECTOR_REGISTRY_SCOPE = '6a5dfdff7cf05623332758b7';

const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { runConnectorRegistryRefresh, connectorRegistryRefreshConfigured } = await import(
  '../services/connectorRegistryRefresh.js'
);
const { getConnector } = await import('../db/repos/connectorRegistry.js');

const CONNECTOR_ID = 'shared_dropbox';

async function main() {
  await connectDb(config.CSGE_DB);

  console.log('configured:', connectorRegistryRefreshConfigured());
  if (!connectorRegistryRefreshConfigured()) throw new Error('sweep did not pick up env vars — test invalid');

  const before = await getConnector(CONNECTOR_ID);
  if (!before) throw new Error(`${CONNECTOR_ID} not found — run the population scripts first`);
  console.log('before capturedAt:', before.capturedAt);

  const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await getDb(config.CSGE_DB).collection('connectors').updateOne({ connectorId: CONNECTOR_ID }, { $set: { capturedAt: staleDate } });
  console.log('backdated to:', staleDate);

  await runConnectorRegistryRefresh();

  const after = await getConnector(CONNECTOR_ID);
  console.log('after capturedAt:', after?.capturedAt);
  console.log('after operationCount:', after?.operationCount);

  if (!after || after.capturedAt.getTime() <= staleDate.getTime()) {
    throw new Error('FAIL — capturedAt did not advance; sweep did not actually touch this connector');
  }
  console.log('PASS — sweep detected the stale connector, live-recaptured it, and refreshed capturedAt.');

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
