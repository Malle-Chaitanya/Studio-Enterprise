/** One-time: re-key rows stored under the project NUMBER to the project ID.
 *
 *  Discovery returns the project NUMBER, the GEMINI_PROJECT override uses the ID, and
 *  rows are keyed by whichever string was current. A mismatch makes the drift snapshot
 *  unfindable, so a migrated agent takes the "no prior snapshot" path and is skipped
 *  instead of redeployed. Same story for the knowledge-store cache.
 *
 *  npx tsx src/spikes/_fix_project_key_normalize.ts <fromProject> <toProject> [--apply]
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';

const FROM = process.argv[2]!, TO = process.argv[3]!;
const APPLY = process.argv.includes('--apply');
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);

for (const coll of ['migratedAgentSnapshots', 'adkKnowledgeStores']) {
  const n = await db.collection(coll).countDocuments({ project: FROM });
  console.log(`${coll}: ${n} row(s) with project=${FROM}`);
  if (APPLY && n) {
    const r = await db.collection(coll).updateMany({ project: FROM }, { $set: { project: TO } });
    console.log(`   -> updated ${r.modifiedCount}`);
  }
}
if (!APPLY) console.log('\n(dry run — pass --apply to write)');
await c.close(); process.exit(0);
