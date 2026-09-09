/** What does a migrationLogs row actually look like? Read-only. npx tsx src/spikes/_diag_inspect_migration_logs_schema.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const rows = await getDb().collection('migrationLogs').find({}).sort({ $natural: -1 }).limit(3).toArray();
console.log(`${rows.length} rows found.`);
console.log(JSON.stringify(rows, null, 2).slice(0, 3000));
process.exit(0);
