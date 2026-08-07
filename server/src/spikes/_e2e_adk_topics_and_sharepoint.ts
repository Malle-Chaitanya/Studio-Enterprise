/**
 * One agent, three things proven together:
 *   1. TOPICS as sub-agents inside a SINGLE deployment (not one engine per topic)
 *   2. SharePoint tools SCOPED to the folder the source Copilot agent actually named
 *   3. Reading file CONTENT live (text / PDF / Word / Excel extracted in-container)
 *
 * Source of truth is the real Copilot agent "CloudFuze Studio Migrate" in the default
 * environment: its knowledge source is
 *   https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions
 * and its topics become the sub-agents. Nothing here is invented — the URL, the topic
 * names and the instruction all come from the extracted IR.
 *
 * Costs ONE agent-creation unit (quota is ~7/day), which is the point of combining all
 * three into a single deployment rather than testing them separately.
 *
 * npx tsx src/spikes/_e2e_adk_topics_and_sharepoint.ts
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
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { resolveDestination } from '../services/gemini.js';
import { chatWithAdkAgent, createAdkSession, getReasoningEngineMethods } from '../services/adkAgentChat.js';
import type { Session } from '../sessionStore.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const ENGINE = process.env.E2E_ENGINE ?? 'gemini-enterprise-17847887_1784788734248';
const SOURCE_ENV = process.env.E2E_SOURCE_ENV ?? 'https://orga243378d.crm.dynamics.com';
const SOURCE_AGENT = process.env.E2E_SOURCE_AGENT ?? 'CloudFuze Studio Migrate';
const DISPLAY = process.env.E2E_AGENT_NAME ?? 'CloudFuze Studio Migrate (ADK, topics + SharePoint)';
const CONNECTOR = 'shared_sharepointonline';
const USER_ID = 'cf-e2e-user';

const TENANT = process.env.MS_GRAPH_TENANT_ID ?? '';
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET ?? '';
if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set MS_GRAPH_* in server/.env');
  process.exit(1);
}

async function saToken(): Promise<string> {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

// ── 1. Extract the REAL source agent ──────────────────────────────────────────
console.log('═══ 1. Extract source Copilot agent ═══');
await connectMongo();
const session = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
if (!session?.tenantId) { console.error('no tenant in cached session'); process.exit(1); }
const dvToken = await clientCredsToken(session.tenantId, SOURCE_ENV);
const bots = await listBots(SOURCE_ENV, dvToken);
const bot = bots.find((b) => b.name === SOURCE_AGENT);
if (!bot) { console.error(`agent "${SOURCE_AGENT}" not found in ${SOURCE_ENV}`); process.exit(1); }
const ir = await extractAgent(SOURCE_ENV, dvToken, bot);

const spSource = ir.knowledgeSources.find((k) => /sharepoint/i.test(k.kind) || /sharepoint\.com/i.test(k.reference ?? ''));
const scopeUri = spSource?.reference ?? spSource?.references?.[0] ?? '';
const customTopics = ir.topics.filter((t) => !t.isSystem);
console.log(`  agent          : ${ir.name}`);
console.log(`  instruction    : ${ir.instructions?.length ?? 0} chars`);
console.log(`  SharePoint URL : ${scopeUri || '(none found)'}`);
console.log(`  custom topics  : ${customTopics.map((t) => t.name.trim()).join(', ') || '(none)'}`);
if (!scopeUri) { console.error('  no SharePoint knowledge source — nothing to scope to'); process.exit(1); }

// ── 2. Credentials (shared ms_graph group) ────────────────────────────────────
const token = await saToken();
console.log('\n═══ 2. Graph credentials → Secret Manager ═══');
for (const [field, value] of Object.entries({ tenant_id: TENANT, client_id: CLIENT_ID, client_secret: CLIENT_SECRET })) {
  await upsertSecret(token, PROJECT, connectorSecretId(CONNECTOR, field), value);
}
console.log('  ms_graph credentials stored (values never printed)');

// ── 3. Build spec: scoped SharePoint tools + topics as sub-agents ─────────────
const specs = buildLiveConnectorSpecs([CONNECTOR]).map((s) => ({ ...s, scopeUri }));
const subAgents = customTopics.map((t) => {
  const name = t.name.trim();
  return {
    id: name,
    displayName: name,
    // The ROOT model routes on this text, so it must say when to hand over.
    description: `Handles "${name}" requests — the migrated Copilot topic of the same name.`,
    instruction:
      `You handle the "${name}" topic, migrated from Microsoft Copilot Studio.\n` +
      (t.aiPrompt ? `\nOriginal AI Builder prompt:\n${t.aiPrompt}\n` : '') +
      `\nStay within this topic. If the user asks about SharePoint documents, use your ` +
      `SharePoint tools. If the request is outside "${name}", say so briefly so the main ` +
      `assistant can take over.`,
  };
});
console.log(`\n═══ 3. Spec ═══`);
console.log(`  scopeUri  : ${scopeUri}`);
console.log(`  subAgents : ${subAgents.map((s) => s.id).join(', ') || '(none)'}`);

const INSTRUCTION = [
  (ir.instructions ?? '').trim(),
  '',
  '---',
  '',
  'You are connected to ONE SharePoint folder and have two tools:',
  '  sharepoint_list_files(subfolder)  — list what is in the folder',
  '  sharepoint_read_file(file_path)   — read the text of a file (txt, md, csv, json, PDF, Word, Excel)',
  '',
  'When asked what a document says, READ it with sharepoint_read_file and answer from its',
  'content, quoting the file name. Never guess a document\'s contents. If a file type cannot',
  'be read, say exactly which file and why.',
].join('\n');

// ── 4. Deploy ─────────────────────────────────────────────────────────────────
console.log('\n═══ 4. Deploy (one engine: root + sub-agents + scoped SharePoint tools) ═══');
const resolved = await resolveDestination(PROJECT, token);
const dest = { ...resolved, engine: ENGINE };
const dep = await deployReasoningEngine(PROJECT, LOCATION, {
  name: 'cf_studio_migrate_topics_sp',
  displayName: DISPLAY,
  description: ir.description || 'Migrated Copilot agent with topic sub-agents and live SharePoint access.',
  model: 'gemini-2.5-flash',
  instruction: INSTRUCTION,
  tools: [],
  liveConnectors: specs,
  subAgents,
}, { timeoutMs: 25 * 60_000 });
console.log(`  ok=${dep.ok} ${dep.reasoningEngine ?? dep.error ?? ''}`);
if (!dep.ok || !dep.reasoningEngine) process.exit(1);
const reId = dep.reasoningEngine.split('/').pop()!;
console.log(`  framework=${(await getReasoningEngineMethods(PROJECT, token, reId, LOCATION))?.framework}`);

// ── 5. Register ───────────────────────────────────────────────────────────────
console.log('\n═══ 5. Register ═══');
const reg = await registerAdkAgent(dest, token, {
  reasoningEngine: dep.reasoningEngine,
  displayName: DISPLAY,
  description: 'Migrated Copilot agent: topic sub-agents + scoped live SharePoint tools.',
});
console.log(`  registered=${reg.registered} agentId=${reg.agentId ?? '-'} state=${reg.state ?? '-'} ${reg.error ?? ''}`);

// ── 6. Ask — each question targets one of the three claims ────────────────────
console.log('\n═══ 6. Questions ═══');
const sessionId = (await createAdkSession(PROJECT, token, reId, USER_ID, LOCATION)) ?? undefined;
const asks: Array<[string, string]> = [
  ['scoped listing', 'What files are in the SharePoint folder you are connected to?'],
  ['READ file content', 'Read daily_queries.txt and tell me exactly what it contains.'],
  ['topic routing', 'Hello there!'],
  ['out of scope', 'List every SharePoint site in the tenant.'],
];
for (const [label, q] of asks) {
  const r = await chatWithAdkAgent(PROJECT, token, { reasoningEngineId: reId, message: q, userId: USER_ID, sessionId, location: LOCATION });
  console.log(`\n  [${label}] Q: ${q}`);
  console.log(r.ok ? `  A: ${(r.answer ?? '(empty)').replace(/\s+/g, ' ').slice(0, 500)}` : `  FAIL ${r.error}`);
}

console.log(`\n════ done ════
  agent           : ${reg.agentId ?? '-'}  "${DISPLAY}"  state=${reg.state ?? '-'}
  reasoningEngine : ${reId}
  sub-agents      : ${subAgents.length} (in ONE engine)
  sharepoint scope: ${scopeUri}
`);
process.exit(0);
