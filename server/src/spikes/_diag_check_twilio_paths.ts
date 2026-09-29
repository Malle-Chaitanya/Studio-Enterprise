/**
 * Checks whether Twilio's real captured operations look like Twilio's actual REST API
 * (vendor-path style, same shape as Jira/Confluence/Teams) or like Google Drive's
 * invented "dataset" abstraction (proxy-only style) — to answer whether Twilio's
 * missing VENDOR_BINDINGS entry is the same easy gap as Dropbox, or the same hard gap
 * as Drive.
 *
 * Run: npx tsx src/spikes/_diag_check_twilio_paths.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const conn = await db.collection('connectors').findOne({ connectorId: 'shared_twilio' });
  console.log('shared_twilio in registry:', Boolean(conn));
  console.log('proxyHost:', conn?.proxyHost);

  const ops = await db.collection('connectorOperations').find({ connectorId: 'shared_twilio' }).limit(8).toArray();
  console.log('sample operations:');
  for (const o of ops) console.log(' ', o.method, o.path);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
