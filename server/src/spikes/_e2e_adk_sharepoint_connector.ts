/**
 * Deploy an ADK agent whose ONLY tool is the live SharePoint (Microsoft Graph)
 * connector, and prove it calls Graph for real.
 *
 * Deliberately no grounding data store: one variable at a time. If this answers, the
 * whole oauth2-client-credentials path works — Secret Manager read in-container,
 * client_credentials mint against the tenant, token cache, Graph call. Adding an
 * indexed store at the same time would leave a failure ambiguous between the connector
 * and the multi-tool wiring, and agent creation is quota-limited (~7/day).
 *
 * Credentials come from the shared ms_graph credential group, so the same app serves
 * every Microsoft connector later.
 *
 * npx tsx src/spikes/_e2e_adk_sharepoint_connector.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { buildLiveConnectorSpecs } from '../services/connectorToolBuilder.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { resolveDestination } from '../services/gemini.js';
import { chatWithAdkAgent, createAdkSession, getReasoningEngineMethods } from '../services/adkAgentChat.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const ENGINE = process.env.E2E_ENGINE ?? 'gemini-enterprise-17847887_1784788734248';
const DISPLAY = process.env.E2E_AGENT_NAME ?? 'SharePoint Connector Agent (ADK)';
const USER_ID = 'cf-e2e-user';
const CONNECTOR = 'shared_sharepointonline';

const TENANT = process.env.MS_GRAPH_TENANT_ID ?? '';
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET ?? '';
if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET in server/.env');
  process.exit(1);
}

const INSTRUCTION = [
  'You are an assistant for a company that uses Microsoft SharePoint.',
  '',
  'You have ONE tool, call_external_api, which calls Microsoft Graph on the company tenant.',
  'Use it for every question about SharePoint sites, lists, or documents. Never answer from',
  'your own knowledge about the company.',
  '',
  'Useful Graph paths (append to the base URL the tool already knows):',
  '  /sites?search=*                       list all sites',
  '  /sites?search=<term>                  find sites by name',
  '  /sites/{site-id}/lists                lists in a site',
  '  /sites/{site-id}/drive/root/children  documents in a site',
  '',
  'Always report what the tool returned. If the tool returns an error, say so plainly and',
  'quote the error — never invent site names or documents. When you list sites, give their',
  'displayName and webUrl.',
].join('\n');

async function saToken(): Promise<string> {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

const token = await saToken();

// ── 1. Credentials into the SHARED ms_graph namespace ─────────────────────────
console.log('═══ 1. MS Graph app credentials → Secret Manager (shared ms_graph scope) ═══');
for (const [field, value] of Object.entries({
  tenant_id: TENANT,
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
})) {
  const secretId = connectorSecretId(CONNECTOR, field);
  await upsertSecret(token, PROJECT, secretId, value);
  console.log(`  ${secretId} ✔`); // value never printed
}

// ── 2. Build the live tool spec from the registry ─────────────────────────────
const specs = buildLiveConnectorSpecs([CONNECTOR]);
console.log('\n═══ 2. Live connector spec ═══');
console.log(`  connector : ${specs[0]?.name}`);
console.log(`  authKind  : ${specs[0]?.authKind}`);
console.log(`  tokenUrl  : ${specs[0]?.tokenUrlTemplate}`);
console.log(`  scope     : ${specs[0]?.scope}`);
console.log(`  secretIds : ${Object.entries(specs[0]?.secretIds ?? {}).map(([k, v]) => `${k}->${v}`).join(', ')}`);
if (!specs.length) { console.error('  no spec built — connector missing from registry'); process.exit(1); }

// ── 3. Deploy ─────────────────────────────────────────────────────────────────
console.log('\n═══ 3. Deploy Reasoning Engine (connector tool only, no data store) ═══');
const resolved = await resolveDestination(PROJECT, token);
const dest = { ...resolved, engine: ENGINE };
const dep = await deployReasoningEngine(PROJECT, LOCATION, {
  name: 'e2e_sharepoint_connector',
  displayName: DISPLAY,
  description: 'Calls Microsoft Graph live for SharePoint sites, lists and documents.',
  model: 'gemini-2.5-flash',
  instruction: INSTRUCTION,
  tools: [],
  liveConnectors: specs,
}, { timeoutMs: 20 * 60_000 });
console.log(`  ok=${dep.ok} ${dep.reasoningEngine ?? dep.error ?? ''}`);
if (!dep.ok || !dep.reasoningEngine) process.exit(1);
const reId = dep.reasoningEngine.split('/').pop()!;
const info = await getReasoningEngineMethods(PROJECT, token, reId, LOCATION);
console.log(`  framework=${info?.framework}`);

// ── 4. Register ───────────────────────────────────────────────────────────────
console.log('\n═══ 4. Register into engine ═══');
const reg = await registerAdkAgent(dest, token, {
  reasoningEngine: dep.reasoningEngine,
  displayName: DISPLAY,
  description: 'Live SharePoint / Microsoft Graph connector agent.',
});
console.log(`  registered=${reg.registered} agentId=${reg.agentId ?? '-'} state=${reg.state ?? '-'} ${reg.error ?? ''}`);

// ── 5. Ask ────────────────────────────────────────────────────────────────────
console.log('\n═══ 5. Questions ═══');
const sessionId = (await createAdkSession(PROJECT, token, reId, USER_ID, LOCATION)) ?? undefined;
const questions = (process.env.E2E_QUESTIONS ?? [
  'What SharePoint sites do we have? List their names and URLs.',
  'Search SharePoint for a site with "test" in the name.',
  'What documents are in the first site you found?',
].join('|')).split('|');

for (const q of questions) {
  const r = await chatWithAdkAgent(PROJECT, token, {
    reasoningEngineId: reId, message: q, userId: USER_ID, sessionId, location: LOCATION,
  });
  console.log(`\n  Q: ${q}`);
  if (!r.ok) { console.log(`  FAIL ${r.error}`); continue; }
  console.log(`  toolInvoked=${r.usedSearchTool}`);
  console.log(`  A: ${(r.answer ?? '(empty)').replace(/\s+/g, ' ').slice(0, 600)}`);
}

console.log(`\n════ done ════
  reasoningEngine : ${reId}
  agent           : ${reg.agentId ?? '-'}  state=${reg.state ?? '-'}
  connector       : SharePoint via Microsoft Graph (client_credentials, shared ms_graph app)
`);
