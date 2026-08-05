/**
 * Recovery for KB-Grounding-Test-Agent's dangling knowledge-store reference:
 * the already-deployed Reasoning Engine's VertexAiSearchTool points at a
 * deterministic dataStoreId that no longer exists (deleted out-of-band after
 * the adkKnowledgeStores cache recorded it as "done"). Since that ID is
 * derived deterministically from (sourceId, fileName) — see sanitizeDataStoreId
 * in knowledgeDataStoreExecutor.ts — recreating a data store at the SAME id
 * with the real content fixes the already-deployed agent with no redeploy:
 * the agent's baked-in tool config doesn't need to change, only what it
 * points at needs to exist again.
 *
 *   npx tsx src/spikes/_fix_missing_adk_knowledge_store.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken, discoverGeminiProject } from '../auth/google.js';
import { listBots, extractAgent, fetchFileAttachmentBytes } from '../services/dataverse.js';
import { migrateFileToDocumentStore } from '../services/knowledgeDataStoreExecutor.js';
import { mimeTypeForFile } from '../services/geminiAgentFiles.js';
import { upsertAdkKnowledgeStore } from '../db/repos/adkKnowledgeStores.js';

const BOT_NAME = 'KB-Grounding-Test-Agent';
const FILE_NAME = 'Slack to Teams- Migration Guide.pdf';

async function main() {
  await connectMongo();
  const s = (await getDb(config.CSGE_DB).collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  let ir, envUrl: string | undefined, dvToken: string | undefined;
  for (const env of s.environments ?? []) {
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    let bots;
    try {
      bots = await listBots(env.url, token);
    } catch {
      continue;
    }
    const bot = bots.find((b) => b.name === BOT_NAME);
    if (!bot) continue;
    envUrl = env.url;
    dvToken = token;
    ir = await extractAgent(env.url, token, bot);
    break;
  }
  if (!ir || !envUrl || !dvToken) throw new Error(`bot "${BOT_NAME}" not found in any connected environment`);

  const ks = ir.knowledgeSources.find((k) => k.name === FILE_NAME);
  if (!ks) throw new Error(`knowledge source "${FILE_NAME}" not found on ${BOT_NAME}`);
  console.log(`found knowledge source: id=${ks.id} name=${ks.name}`);

  const saToken = await getSaToken();
  const project = await discoverGeminiProject(saToken);
  console.log(`project: ${project}`);

  const got = await fetchFileAttachmentBytes(envUrl, dvToken, ks.id);
  if (!got) throw new Error('could not download file bytes from Dataverse');
  console.log(`downloaded ${got.bytes.length} bytes, contentType=${got.contentType}`);

  const ground = await migrateFileToDocumentStore(project, saToken, ir.sourceId, {
    name: FILE_NAME,
    bytes: got.bytes,
    mimeType: mimeTypeForFile(FILE_NAME, got.contentType),
  });
  console.log('migrateFileToDocumentStore result:', JSON.stringify(ground, null, 2));

  if (ground.resourcePath) {
    await upsertAdkKnowledgeStore({
      appUserId: 'default',
      sourceId: ir.sourceId,
      fileName: FILE_NAME,
      dataStoreId: ground.dataStoreId ?? '',
      resourcePath: ground.resourcePath,
      status: 'done',
    });
    console.log('adkKnowledgeStores cache updated. Data store recreated at:', ground.resourcePath);
    console.log('This is the SAME address the deployed agent already points at — no redeploy needed.');
  } else {
    console.log('FAILED — data store was not recreated:', ground.error);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
