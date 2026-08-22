import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
// Where do connector operation ids actually live? Search the whole document for the key.
const rows = await db.collection('stagedAgents').find({}).limit(200).toArray();
const paths = new Map<string, number>();
function walk(o: unknown, path: string, depth = 0) {
  if (depth > 6 || o === null || typeof o !== 'object') return;
  if (Array.isArray(o)) { if (o.length) walk(o[0], `${path}[]`, depth + 1); return; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (/^operationid$|^connectorid$/i.test(k)) paths.set(`${path}.${k}`, (paths.get(`${path}.${k}`) ?? 0) + 1);
    walk(v, `${path}.${k}`, depth + 1);
  }
}
for (const r of rows) walk(r, '');
console.log('paths carrying operationId / connectorId:');
for (const [p, n] of [...paths].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${p}`);
process.exit(0);
