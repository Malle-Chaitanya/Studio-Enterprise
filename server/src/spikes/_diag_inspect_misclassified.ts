/**
 * Dropbox and Zendesk got flagged proxy-only-likely, which contradicts their known real
 * REST APIs. Print their actual stripped paths to find out whether the heuristic has a
 * bug or whether these connectors genuinely are abstraction-style.
 *
 * Run: npx tsx src/spikes/_diag_inspect_misclassified.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  for (const connectorId of ['shared_dropbox', 'shared_zendesk']) {
    const ops = await db.collection('connectorOperations').find({ connectorId }).project({ path: 1 }).toArray();
    console.log(`\n=== ${connectorId} (${ops.length} ops) ===`);
    for (const o of ops) console.log(' ', o.path);
  }

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
