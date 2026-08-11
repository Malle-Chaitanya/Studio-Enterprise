import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { listBots } from '../services/dataverse.js';
import { resolveScope } from '../services/scope.js';
import { runMigration } from '../orchestrator.js';
import { defaultDestination } from '../services/gemini.js';
import { migrateSharePointDriveItem } from '../services/knowledgeDataStoreExecutor.js';
import type { MigrationResult } from '../types.js';

const NAME_MATCH = 'CS_GE Knowledge Test Agent';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  let targetEnv: { url: string; name: string } | null = null;
  let botId: string | null = null;
  for (const env of s.environments ?? []) {
    try {
      const token = await clientCredsToken(s.tenantId ?? '', env.url);
      const bots = await listBots(env.url, token);
      const bot = bots.find((b) => b.name === NAME_MATCH);
      if (bot) {
        targetEnv = env;
        botId = bot.botid;
        break;
      }
    } catch (e) {
      console.log(`  (skipping env ${env.name}: ${(e as Error).message})`);
    }
  }
  if (!targetEnv || !botId) throw new Error(`"${NAME_MATCH}" not found in any environment`);
  console.log(`Found bot ${botId} in env ${targetEnv.name}`);

  const plan = await resolveScope(s, { kind: 'agents', env: targetEnv.url, botIds: [botId] }, {});
  console.log(`Resolved plan: ${plan.totalAgents} agent(s)`);

  console.log('\nRunning live migration...');
  let finalResult: MigrationResult | null = null;
  for await (const evt of runMigration(s, plan)) {
    if (evt.type === 'log') console.log(`  [${evt.level}] ${evt.msg}`);
    if (evt.type === 'agent') finalResult = evt.result;
    if (evt.type === 'done') console.log(`DONE: ${evt.summary}`);
  }

  if (!finalResult?.geminiAgentId) {
    throw new Error(`migration finished but no geminiAgentId on result: ${JSON.stringify(finalResult)}`);
  }
  console.log(`\nFresh agentId: ${finalResult.geminiAgentId}`);

  if (!s.geminiProject) throw new Error('session has no geminiProject');
  const dest = defaultDestination(s.geminiProject);
  const [saToken, graphToken] = await Promise.all([
    getSaToken(s.gEmail),
    clientCredsToken(s.tenantId ?? '', 'https://graph.microsoft.com'),
  ]);

  const item = {
    driveId: 'b!XZcRew90a0OtJxtF_HAgX_9Z9KMdL4xKg_XOXJJGBn394Z24VXHgT6JKgGLvHkNe',
    itemId: '01NMN5O4AF6TFWDO7WHRG2O53NU3WIWIVQ',
    name: 'CloudFuze Debugging Guide.docx',
  };

  console.log(`\nAttaching "${item.name}" LIVE to fresh agent ${finalResult.geminiAgentId}...`);
  const res = await migrateSharePointDriveItem(dest, saToken, graphToken, finalResult.geminiAgentId, item, false);
  console.log('\nAttach result:', JSON.stringify(res, null, 2));
  process.exit(res.error ? 1 : 0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
