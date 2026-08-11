import 'dotenv/config';
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';
import { schedulePendingGroundingRecheck } from '../db/repos/pendingGroundingRechecks.js';
import { runPendingGroundingRechecks } from '../services/groundingRecheck.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = { project: '231705905417', engine: 'gemini-enterprise-17847887_1784788734248', assistant: 'default_assistant' };

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  // Branch 1: not-yet-indexed -> should bump attempts, not delete, not redeploy.
  await schedulePendingGroundingRecheck('default', 'https://TEST-env', 'test-source-not-indexed', DEST, 'fake.txt', 'this-store-does-not-exist-at-all', new Date(Date.now() - 1000));

  // Branch 2: mixed-source agent (CloudFuze Studio Migrate has SharePoint + FileUpload) with an ALREADY-indexed store -> should upsert cache done, then log-and-skip (no redeploy call).
  await schedulePendingGroundingRecheck(
    'default',
    'https://orga243378d.crm.dynamics.com',
    'ee2ea155-208c-f111-ab0f-0022480a981d',
    DEST,
    'Migrate_Agent_PRD_Full (6).pdf',
    'ee2ea155-208c-f111-ab0f-0022480a981d-file-migrate-age-rmshc1i02',
    new Date(Date.now() - 1000),
  );

  console.log('before sweep:', JSON.stringify(await db.collection('pendingGroundingRechecks').find({}).toArray(), null, 2));
  await runPendingGroundingRechecks();
  console.log('after sweep:', JSON.stringify(await db.collection('pendingGroundingRechecks').find({}).toArray(), null, 2));

  // cleanup branch 1's row so it doesn't linger as noise
  await db.collection('pendingGroundingRechecks').deleteOne({ sourceId: 'test-source-not-indexed' });
  console.log('done.');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
