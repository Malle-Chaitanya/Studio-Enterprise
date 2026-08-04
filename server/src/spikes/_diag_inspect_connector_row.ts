/** Inspect (and optionally clear) the stored knowledgeConnectors row for one
 *  site, to see exactly what's persisted vs re-derive it fresh.
 *   npx tsx src/spikes/_diag_inspect_connector_row.ts <siteUrl> [--clear] */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const [siteUrl, flag] = process.argv.slice(2);

async function main() {
  if (!siteUrl) throw new Error('usage: _diag_inspect_connector_row.ts <siteUrl> [--clear]');
  await connectMongo();
  const coll = getDb().collection('knowledgeConnectors');
  const row = await coll.findOne({ kind: 'sharepoint', siteUrl });
  console.log('Current row:', JSON.stringify(row, null, 2));

  if (flag === '--clear' && row) {
    await coll.deleteOne({ _id: row._id });
    console.log('Deleted — next submission for this site will start completely fresh.');
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
