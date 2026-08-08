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
import { getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';
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
  if (!targetEnv || !botId) throw new Error(`"${NAME_MATCH}" not found`);
  console.log(`Found bot ${botId} in env ${targetEnv.name}`);

  const plan = await resolveScope(s, { kind: 'agents', env: targetEnv.url, botIds: [botId] }, {});

  console.log('\nRunning live migration with auto-attach-on-unique-match wired...');
  let finalResult: MigrationResult | null = null;
  for await (const evt of runMigration(s, plan)) {
    if (evt.type === 'log') console.log(`  [${evt.level}] ${evt.msg}`);
    if (evt.type === 'agent') finalResult = evt.result;
  }

  if (!finalResult?.geminiAgentId) throw new Error(`no geminiAgentId: ${JSON.stringify(finalResult)}`);
  console.log(`\n=== Result summary ===`);
  console.log(`agentId: ${finalResult.geminiAgentId}`);
  console.log(`knowledgeFilesUploaded: ${finalResult.knowledgeFilesUploaded}`);
  console.log(`knowledgeFilesFailed: ${finalResult.knowledgeFilesFailed}`);
  console.log(`knowledgeSourceCandidates (still needing human confirm): ${JSON.stringify(finalResult.knowledgeSourceCandidates?.map((c) => ({ name: c.sourceName, n: c.candidates.length })), null, 2)}`);
  console.log(`fidelity notes:`);
  for (const f of finalResult.fidelity) console.log(`  [${f.status}] ${f.component}: ${f.detail}`);

  if (!s.geminiProject) throw new Error('no geminiProject');
  const dest = defaultDestination(s.geminiProject);
  const saToken = await getSaToken(s.gEmail);
  const agent = await getAgent(dest, saToken, finalResult.geminiAgentId);
  console.log(`\nActual agentFiles on the live agent (ground truth via API):`);
  for (const f of readAgentFiles(agent)) console.log(`  - ${f.fileName} (${f.mimeType})`);

  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
