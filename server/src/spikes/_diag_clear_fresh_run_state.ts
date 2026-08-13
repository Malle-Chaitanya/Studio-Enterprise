/** Clear THIS ONE test agent's stale destination-tracking state, scoped precisely by
 *  appUserId+envUrl+sourceId(+connectorId), so a fresh migration run does a clean
 *  create instead of a confusing "update failed (404), falling back to create" and
 *  drift-detection noise. Never touches other customers' data, never a wildcard
 *  delete — prints exactly what matched before deleting.
 *  npx tsx src/spikes/_diag_clear_fresh_run_state.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const APP_USER_ID = '6a5dfdff7cf05623332758b7';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const SOURCE_ID = 'bdf9b817-9b90-f111-b8da-0022480b1f83';

async function main() {
  await connectMongo();
  const db = getDb();

  const targets: Array<{ coll: string; filter: Record<string, unknown> }> = [
    { coll: 'adkDeployments', filter: { appUserId: APP_USER_ID, envUrl: ENV_URL, sourceId: SOURCE_ID } },
    { coll: 'migratedSnapshot', filter: { appUserId: APP_USER_ID, envUrl: ENV_URL, sourceId: SOURCE_ID } },
    { coll: 'agentConnectorIdentity', filter: { appUserId: APP_USER_ID, sourceId: SOURCE_ID, connectorId: 'shared_googledrive' } },
  ];

  for (const t of targets) {
    const matched = await db.collection(t.coll).find(t.filter).toArray();
    console.log(`--- ${t.coll}: ${matched.length} matching record(s) ---`);
    for (const doc of matched) console.log(JSON.stringify(doc, null, 2));
    if (matched.length) {
      const result = await db.collection(t.coll).deleteMany(t.filter);
      console.log(`  deleted: ${result.deletedCount}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
