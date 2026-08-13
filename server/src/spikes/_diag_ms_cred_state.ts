import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('connectorCredentials').find({ connectorId: { $in: ['shared_teams','shared_confluence','shared_jira','shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b'] } }).toArray();
for (const r of rows as any[]) console.log(`${r.connectorId}\n  project=${r.project} fields=${JSON.stringify(r.fields)} updatedAt=${r.updatedAt?.toISOString?.() ?? '?'} validation=${r.validation?.code ?? '(none)'}`);
process.exit(0);
