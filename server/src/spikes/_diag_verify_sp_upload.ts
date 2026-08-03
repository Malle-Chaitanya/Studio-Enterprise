import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { migrateSharePointDriveItem } from '../services/knowledgeDataStoreExecutor.js';

const LIVE = process.argv[2] === '--live';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  const result = await getDb()
    .collection('migrationResults')
    .find({ name: 'CS_GE Knowledge Test Agent' })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  if (!result) throw new Error('no stored migrationResults for "CS_GE Knowledge Test Agent" — run a live migration first');
  const agentId = (result as { geminiAgentId?: string }).geminiAgentId;
  if (!agentId) throw new Error('stored result has no geminiAgentId');
  console.log(`Using agentId=${agentId} (from run ${(result as { runId?: string }).runId}, updated ${(result as { updatedAt?: Date }).updatedAt})`);

  if (!s.geminiProject) throw new Error('session has no geminiProject');
  const dest = defaultDestination(s.geminiProject);
  console.log(`Destination: ${JSON.stringify(dest)}`);

  const [saToken, graphToken] = await Promise.all([
    getSaToken(s.gEmail),
    clientCredsToken(s.tenantId ?? '', 'https://graph.microsoft.com'),
  ]);

  // The one unambiguous candidate found for "TestingPermissions" in the prior
  // live search run (_diag_verify_search_wiring.ts).
  const item = {
    driveId: 'b!XZcRew90a0OtJxtF_HAgX_9Z9KMdL4xKg_XOXJJGBn394Z24VXHgT6JKgGLvHkNe',
    itemId: '01NMN5O4AF6TFWDO7WHRG2O53NU3WIWIVQ',
    name: 'CloudFuze Debugging Guide.docx',
  };

  console.log(`\nRunning migrateSharePointDriveItem (dryRun=${!LIVE}) for "${item.name}"...`);
  const res = await migrateSharePointDriveItem(dest, saToken, graphToken, agentId, item, !LIVE);
  console.log('\nResult:', JSON.stringify(res, null, 2));
  process.exit(res.error ? 1 : 0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
