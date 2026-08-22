/** What the newest staged row says about each knowledge source's connector wiring. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const botId = process.argv[2];
await connectMongo();
const row = await getDb().collection('stagedAgents')
  .find({ sourceId: botId }).sort({ _id: -1 }).limit(1).next() as any;
if (!row) throw new Error('no staged row');
console.log('staged', row.stagedAt, 'run', row.runId, 'status', row.status);
console.log('knowledgeCount', row.knowledgeCount, 'auto', row.knowledgeAutoMigratable, 'manual', row.knowledgeManual);
for (const ks of (row.knowledge ?? [])) {
  console.log('---');
  console.log('  name        :', ks.name);
  console.log('  kind        :', ks.kind);
  console.log('  strategy    :', ks.classification?.strategy);
  console.log('  requiresConn:', ks.classification?.requiresConnectorId ?? '(none)');
  console.log('  spaces      :', ks.confluenceSpaceNames ?? []);
  console.log('  url         :', String(ks.url ?? ks.siteUrl ?? ks.sharePointUrl ?? '').slice(0, 130));
}
process.exit(0);
