/**
 * Answers directly: does bindOperation() — the REAL production function that decides
 * whether an operation can actually be turned into a callable tool — succeed for a
 * connector that is NOT in the hand-maintained VENDOR_BINDINGS table?
 *
 * Tests it against the real captured shared_dropbox index (the connector we earlier
 * proved working end-to-end via generic_rest.py) to check whether that earlier proof
 * covered the real bindOperation() path, or bypassed it with a hand-built boundOperations
 * dict.
 *
 * Run: npx tsx src/spikes/_diag_does_new_connector_bind.ts
 */
const { connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { loadFromRegistry } = await import('../db/repos/connectorRegistry.js');
const { bindOperation, VENDOR_BINDINGS } = await import('../connectors/operationBinding.js');

async function main() {
  await connectDb(config.CSGE_DB);

  console.log('Is shared_dropbox in VENDOR_BINDINGS?', 'shared_dropbox' in VENDOR_BINDINGS);
  console.log('VENDOR_BINDINGS known connector ids:', Object.keys(VENDOR_BINDINGS));

  const index = await loadFromRegistry('shared_dropbox');
  if (!index) throw new Error('no captured index for shared_dropbox — run the population script first');

  const opId = Object.keys(index.operations).find((id) => id.toLowerCase().includes('listfolder')) ?? Object.keys(index.operations)[0];
  console.log('testing bindOperation for real captured operation:', opId);

  const result = bindOperation(index, opId);
  console.log('bindOperation result:', JSON.stringify(result, null, 2));

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
