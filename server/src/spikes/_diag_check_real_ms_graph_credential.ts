/** What appUserId/project actually holds the real, working ms_graph credential record
 *  (the one this whole session's live Graph calls have used)? Read-only.
 *  npx tsx src/spikes/_diag_check_real_ms_graph_credential.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const rows = await getDb()
  .collection('connectorCredentials')
  .find({ connectorId: { $in: ['shared_teams', 'shared_onedrive', 'shared_excelonlinebusiness', 'shared_office365'] } })
  .toArray();
console.log(`Found ${rows.length} row(s):`);
for (const r of rows) {
  console.log(`  appUserId=${r.appUserId} connectorId=${r.connectorId} project=${r.project} fields=${JSON.stringify(r.fields)}`);
}

// Also check the migrationSessions this whole session's Dataverse work has been using,
// to see which appUserId those runs were actually attributed to.
const sessions = await getDb()
  .collection('migrationSessions')
  .find({ dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(3)
  .toArray();
console.log(`\nRecent migrationSessions (appUserId, geminiProject):`);
for (const s of sessions) console.log(`  appUserId=${s.appUserId} geminiProject=${s.geminiProject}`);
process.exit(0);
