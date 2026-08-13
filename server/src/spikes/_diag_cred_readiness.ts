/** Which credential groups are stored, for the project we migrate into? Metadata only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('connectorCredentials').find({}).toArray();
for (const r of rows as any[]) {
  console.log(`${r.connectorId}  project=${r.project}  fields=${JSON.stringify(r.fields ?? Object.keys(r.secretIds ?? {}))}  validation=${r.validation?.code ?? '(none)'}`);
}
process.exit(0);
