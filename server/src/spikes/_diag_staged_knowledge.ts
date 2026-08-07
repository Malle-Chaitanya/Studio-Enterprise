/** Which staged agents actually NEED a native connector, and which auto-migrate?
 *
 *  The "Connectors needed" page lists a SharePoint site with the agents referencing it.
 *  To tell a missing-attribution bug apart from correct behaviour you need the staged
 *  truth: only a SharePointSearchSource needs the native connector. A
 *  FederatedStructuredSearchSource (Confluence and every other federated product) is
 *  crawled and indexed by us, so its agent SHOULD NOT appear on that page.
 *
 *  Knowledge lives at the row ROOT as `knowledge`, not under `mapped.ir`.
 *
 *  npx tsx src/spikes/_diag_staged_knowledge.ts [runId]
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';

const runId = process.argv[2];
const client = await MongoClient.connect(config.MONGO_HOST);
const db = client.db(config.CSGE_DB);

const rows = (await db
  .collection('stagedAgents')
  .find(runId ? { runId } : {})
  .sort({ _id: -1 })
  .limit(20)
  .toArray()) as Array<Record<string, any>>;

console.log(`stagedAgents: ${rows.length}${runId ? ` (runId=${runId})` : ' (latest 20)'}`);

for (const r of rows) {
  console.log(`\n=== ${r.name}  (${r.envName}) ===`);
  console.log(`knowledgeCount=${r.knowledgeCount} auto=${r.knowledgeAutoMigratable} manual=${r.knowledgeManual}`);
  for (const k of (r.knowledge ?? []) as Array<Record<string, any>>) {
    const needsNative = k.kind === 'SharePointSearchSource';
    console.log(`  - ${k.kind} "${k.name ?? ''}"${needsNative ? '   <- needs NATIVE connector' : ''}`);
  }
}

await client.close();
process.exit(0);
