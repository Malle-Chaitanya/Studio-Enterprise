import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATASET = 'csge_reference_snapshots';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(s?.gEmail || undefined);

  // list tables in the dataset
  const tablesRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tablesJson = await tablesRes.json();
  console.log('Tables in dataset:', JSON.stringify((tablesJson as any).tables?.map((t: any) => t.tableReference?.tableId), null, 2));

  const tableId = (tablesJson as any).tables?.[0]?.tableReference?.tableId;
  if (!tableId) { console.log('no tables found'); return; }

  // get the table schema
  const schemaRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const schemaJson = await schemaRes.json();
  console.log('\nSchema fields:', JSON.stringify((schemaJson as any).schema?.fields?.map((f: any) => `${f.name}:${f.type}`), null, 2));

  // query a row
  const queryRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `SELECT * FROM \`${PROJECT}.${DATASET}.${tableId}\` LIMIT 1`, useLegacySql: false }),
  });
  const queryJson = await queryRes.json();
  console.log('\nQuery result:', JSON.stringify(queryJson, null, 2).slice(0, 3000));
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(0); });
