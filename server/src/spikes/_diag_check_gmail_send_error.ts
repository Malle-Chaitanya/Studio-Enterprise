/** Find any recent Gmail send-related error in the persisted migration logs, and try to
 *  reproduce the actual auth failure live if none is found. Read-only where possible.
 *  npx tsx src/spikes/_diag_check_gmail_send_error.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const rows = await getDb()
  .collection('migrationLogs')
  .find({ msg: { $regex: /gmail|unauthorized|auth failed/i } })
  .sort({ $natural: -1 })
  .limit(20)
  .toArray();
console.log(`${rows.length} matching log row(s):`);
for (const r of rows) console.log(`  [${r.level}] ${r.ts?.toISOString?.() ?? r.ts} ${r.msg}`);
process.exit(0);
