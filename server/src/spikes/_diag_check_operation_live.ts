/** Directly poll a stored connector's operation, server-side, no browser
 *  caching involved — to get an unambiguous, fresh answer.
 *   npx tsx src/spikes/_diag_check_operation_live.ts <siteUrl> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { getConnectorOperation, getConnectorDataStores } from '../services/geminiConnector.js';

const [siteUrl] = process.argv.slice(2);

async function main() {
  if (!siteUrl) throw new Error('usage: _diag_check_operation_live.ts <siteUrl>');
  await connectMongo();
  const row = await getDb().collection('knowledgeConnectors').findOne({ kind: 'sharepoint', siteUrl });
  if (!row) throw new Error('no stored row for this site');
  console.log('Stored operationName:', row.operationName);
  console.log('Stored collectionId:', row.collectionId);

  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  const op = await getConnectorOperation(token, row.operationName as string);
  console.log('\ngetConnectorOperation result:', JSON.stringify(op, null, 2));

  const ds = await getConnectorDataStores('231705905417', 'global', token, row.collectionId as string);
  console.log('\ngetConnectorDataStores result:', JSON.stringify(ds, null, 2));

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
