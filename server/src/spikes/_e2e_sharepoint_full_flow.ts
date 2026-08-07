/**
 * The whole flow, end to end, on the REAL source agent:
 *
 *   FETCH    read "CloudFuze Studio Migrate" from Copilot Studio (Dataverse)
 *   SELECT   take the SharePoint URL it names as knowledge + its custom topics
 *   CONNECT  use the customer's Entra app credentials (Secret Manager)
 *   MIGRATE  crawl that folder via Graph -> data store, then deploy ONE ADK agent with
 *              • the indexed store        (read document CONTENT, all file types)
 *              • live SharePoint tools    (current state, scoped to that folder)
 *              • topics as sub-agents     (one engine, not one per topic)
 *   VERIFY   ask questions that can only be answered by each path
 *
 * Costs one agent-creation unit.
 *
 * npx tsx src/spikes/_e2e_sharepoint_full_flow.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { buildLiveConnectorSpecs } from '../services/connectorToolBuilder.js';
import { migrateSharePointToDataStore } from '../services/sharePointMigrator.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { resolveDestination } from '../services/gemini.js';
import { chatWithAdkAgent, createAdkSession } from '../services/adkAgentChat.js';
import type { Session } from '../sessionStore.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const ENGINE = process.env.E2E_ENGINE ?? 'gemini-enterprise-17847887_1784788734248';
const SOURCE_ENV = process.env.E2E_SOURCE_ENV ?? 'https://orga243378d.crm.dynamics.com';
const SOURCE_AGENT = process.env.E2E_SOURCE_AGENT ?? 'CloudFuze Studio Migrate';
const DISPLAY = process.env.E2E_AGENT_NAME ?? 'CloudFuze Studio Migrate (full: docs + live + topics)';
const CONNECTOR = 'shared_sharepointonline';
const USER_ID = 'cf-e2e-user';

const TENANT = process.env.MS_GRAPH_TENANT_ID!;
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID!;
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET!;

async function saToken(): Promise<string> {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

// ── FETCH ─────────────────────────────────────────────────────────────────────
console.log('═══ FETCH — source agent from Copilot Studio ═══');
await connectMongo();
const session = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const dvToken = await clientCredsToken(session!.tenantId!, SOURCE_ENV);
const bot = (await listBots(SOURCE_ENV, dvToken)).find((b) => b.name === SOURCE_AGENT);
if (!bot) { console.error(`"${SOURCE_AGENT}" not found`); process.exit(1); }
const ir = await extractAgent(SOURCE_ENV, dvToken, bot);
console.log(`  ${ir.name}: ${ir.knowledgeSources.length} knowledge source(s), ${ir.topics.length} topic(s)`);

// ── SELECT ────────────────────────────────────────────────────────────────────
const spSource = ir.knowledgeSources.find((k) => /sharepoint/i.test(k.kind) || /sharepoint\.com/i.test(k.reference ?? ''));
const siteUrl = spSource?.reference ?? spSource?.references?.[0] ?? '';
const customTopics = ir.topics.filter((t) => !t.isSystem);
console.log('\n═══ SELECT ═══');
console.log(`  SharePoint : ${siteUrl || '(none)'}`);
console.log(`  topics     : ${customTopics.map((t) => t.name.trim()).join(', ') || '(none)'}`);
if (!siteUrl) { console.error('  no SharePoint knowledge source'); process.exit(1); }

// ── CONNECT ───────────────────────────────────────────────────────────────────
const token = await saToken();
console.log('\n═══ CONNECT — credentials to Secret Manager (shared ms_graph app) ═══');
for (const [field, value] of Object.entries({ tenant_id: TENANT, client_id: CLIENT_ID, client_secret: CLIENT_SECRET })) {
  await upsertSecret(token, PROJECT, connectorSecretId(CONNECTOR, field), value);
}
console.log('  stored (values never printed)');

// ── MIGRATE: crawl + index ────────────────────────────────────────────────────
console.log('\n═══ MIGRATE (1/2) — crawl SharePoint via Graph -> data store ═══');
const mig = await migrateSharePointToDataStore(PROJECT, token, ir.sourceId, {
  tenantId: TENANT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, siteUrl,
});
console.log(`  dataStoreId : ${mig.dataStoreId ?? '(none)'}`);
console.log(`  indexed     : ${mig.fileCount} file(s)`);
if (mig.skipped.length) {
  console.log(`  skipped     : ${mig.skipped.length}`);
  for (const s of mig.skipped.slice(0, 8)) console.log(`     - ${s.name}: ${s.reason}`);
}
if (mig.error) console.log(`  error       : ${mig.error}`);
if (!mig.resourcePath) { console.error('  no data store — stopping before spending an agent'); process.exit(1); }

// ── MIGRATE: deploy ───────────────────────────────────────────────────────────
console.log('\n═══ MIGRATE (2/2) — deploy ONE agent: store + live tools + topic sub-agents ═══');
const specs = buildLiveConnectorSpecs([CONNECTOR]).map((s) => ({ ...s, scopeUri: siteUrl }));
const subAgents = customTopics.map((t) => {
  const name = t.name.trim();
  return {
    id: name,
    displayName: name,
    description: `Handles "${name}" requests — the migrated Copilot topic of the same name.`,
    instruction:
      `You handle the "${name}" topic, migrated from Microsoft Copilot Studio.\n` +
      (t.aiPrompt ? `\nOriginal AI Builder prompt:\n${t.aiPrompt}\n` : '') +
      `\nIf the request is outside "${name}", say so briefly so the main assistant takes over.`,
  };
});

const INSTRUCTION = [
  (ir.instructions ?? '').trim(),
  '',
  '---',
  '',
  'You have TWO ways to reach the company SharePoint folder, and they answer different questions:',
  '',
  '1. INDEXED KNOWLEDGE — the documents in that folder have been indexed. Use this to answer',
  '   questions about what a document SAYS. It covers PDFs, Word, Excel and text files.',
  '2. LIVE TOOLS — sharepoint_list_files and sharepoint_read_file call SharePoint right now.',
  '   Use these for what is CURRENTLY there: newly added files, or a file changed since indexing.',
  '',
  'Prefer indexed knowledge for content questions; use the live tools when the user asks what is',
  'there now, or when the indexed knowledge has no answer. Say which source you used. Never',
  'invent a document or its contents.',
].join('\n');

const resolved = await resolveDestination(PROJECT, token);
const dest = { ...resolved, engine: ENGINE };
const dep = await deployReasoningEngine(PROJECT, LOCATION, {
  name: 'cf_studio_migrate_full',
  displayName: DISPLAY,
  description: ir.description || 'Migrated Copilot agent: indexed SharePoint documents, live SharePoint tools, topic sub-agents.',
  model: 'gemini-2.5-flash',
  instruction: INSTRUCTION,
  tools: [],
  groundingDataStores: [mig.resourcePath],
  liveConnectors: specs,
  subAgents,
}, { timeoutMs: 25 * 60_000 });
console.log(`  deploy ok=${dep.ok} ${dep.reasoningEngine ?? dep.error ?? ''}`);
if (!dep.ok || !dep.reasoningEngine) process.exit(1);
const reId = dep.reasoningEngine.split('/').pop()!;

const reg = await registerAdkAgent(dest, token, {
  reasoningEngine: dep.reasoningEngine, displayName: DISPLAY,
  description: 'Indexed + live SharePoint, with migrated topics as sub-agents.',
});
console.log(`  registered=${reg.registered} agentId=${reg.agentId ?? '-'} state=${reg.state ?? '-'} ${reg.error ?? ''}`);

// ── VERIFY ────────────────────────────────────────────────────────────────────
console.log('\n═══ VERIFY ═══');
const sessionId = (await createAdkSession(PROJECT, token, reId, USER_ID, LOCATION)) ?? undefined;
const asks: Array<[string, string]> = [
  ['indexed content', 'What do the documents in SharePoint say about migration queries or conflict reports?'],
  ['live listing', 'What files are in the SharePoint folder right now?'],
  ['live read', 'Read daily_queries.txt and summarise it.'],
  ['topic routing', 'Thank you!'],
  ['must refuse', 'What is our Q1 revenue target?'],
];
for (const [label, q] of asks) {
  const r = await chatWithAdkAgent(PROJECT, token, { reasoningEngineId: reId, message: q, userId: USER_ID, sessionId, location: LOCATION });
  console.log(`\n  [${label}] Q: ${q}`);
  console.log(r.ok ? `  A: ${(r.answer ?? '(empty)').replace(/\s+/g, ' ').slice(0, 420)}` : `  FAIL ${r.error}`);
}

console.log(`\n════ done ════
  agent      : ${reg.agentId ?? '-'}  "${DISPLAY}"  state=${reg.state ?? '-'}
  engine     : ${reId}
  data store : ${mig.dataStoreId} (${mig.fileCount} file(s), layout parsing + image annotation)
  live scope : ${siteUrl}
  sub-agents : ${subAgents.length}
`);
process.exit(0);
