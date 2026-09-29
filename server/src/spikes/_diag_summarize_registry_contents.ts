/**
 * Summarizes exactly what's stored in the connector registry right now — real counts and
 * one real sample record from each collection — to answer "what did we actually store".
 *
 * Run: npx tsx src/spikes/_diag_summarize_registry_contents.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const connectorCount = await db.collection('connectors').countDocuments();
  const opCount = await db.collection('connectorOperations').countDocuments();
  const msOwnCount = await db.collection('connectors').countDocuments({ isMicrosoftOwnService: true });
  const thirdPartyCount = await db.collection('connectors').countDocuments({ isMicrosoftOwnService: false });

  console.log('=== Counts ===');
  console.log('connectors:', connectorCount);
  console.log('connectorOperations:', opCount);
  console.log('Microsoft-own-service connectors:', msOwnCount);
  console.log('third-party-wrapped connectors:', thirdPartyCount);

  console.log('\n=== Sample connector record (shared_zendesk) ===');
  console.log(JSON.stringify(await db.collection('connectors').findOne({ connectorId: 'shared_zendesk' }), null, 2));

  console.log('\n=== Sample operation record (one Zendesk operation) ===');
  console.log(JSON.stringify(await db.collection('connectorOperations').findOne({ connectorId: 'shared_zendesk' }), null, 2));

  console.log('\n=== Category breakdown ===');
  const categories = await db.collection('connectors').aggregate([
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();
  console.log(categories);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
