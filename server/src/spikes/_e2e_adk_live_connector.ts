/**
 * Track B proof: give a migrated ADK agent a LIVE Confluence tool alongside its
 * indexed knowledge, and show the tool really executes HTTP.
 *
 * The discriminator matters. The agent's data store covers ITINFRA + SALES only.
 * "What are the Python coding standards?" lives in the ENG space, which is NOT
 * indexed — so:
 *   - answered  => the live tool actually called Confluence
 *   - refused   => only the indexed store worked; the live tool did not fire
 * That distinction is the whole point; a question answerable from the index would
 * prove nothing.
 *
 * Credentials go to Secret Manager and are read inside the container at call time,
 * never placed in the agent instruction (where any user could extract them by
 * asking the agent to repeat its prompt).
 *
 * npx tsx src/spikes/_e2e_adk_live_connector.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { resolveDestination } from '../services/gemini.js';
import { chatWithAdkAgent, createAdkSession, getReasoningEngineMethods } from '../services/adkAgentChat.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const ENGINE = process.env.E2E_ENGINE ?? 'gemini-enterprise-17847887_1784788734248';
const DS_ID = process.env.E2E_DATA_STORE ?? 'e2e-itinfra-sales-confluence';
const DISPLAY = process.env.E2E_AGENT_NAME ?? 'IT + Sales Agent w/ Live Confluence (ADK)';
const USER_ID = 'cf-e2e-user';

const BASE_URL = process.env.CONFLUENCE_BASE_URL ?? '';
const EMAIL = process.env.CONFLUENCE_EMAIL ?? '';
const TOKEN = process.env.CONFLUENCE_TOKEN ?? '';
if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error('Missing CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_TOKEN in server/.env');
  process.exit(1);
}

const INSTRUCTION =
  'You are a company assistant with two sources of knowledge.\n' +
  '1. An indexed Confluence knowledge base covering the IT Infrastructure and Sales and Revenue spaces — prefer this for those topics.\n' +
  '2. A live Confluence search tool (confluence_live_search) that queries the company Confluence instance in real time, including spaces the index does not cover and pages created after indexing.\n' +
  'When the indexed knowledge base has no answer, ALWAYS try confluence_live_search before giving up. ' +
  'Cite the Confluence page title you used and say whether it came from the indexed base or a live lookup. ' +
  'If neither source has it, say: "I do not have that information."';

async function saToken(): Promise<string> {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

const token = await saToken();

// ── 1. Credentials into Secret Manager ────────────────────────────────────────
console.log('═══ 1. Store Confluence creds in Secret Manager ═══');
const secretIds = {
  base_url: connectorSecretId('confluence', 'base_url'),
  email: connectorSecretId('confluence', 'email'),
  api_token: connectorSecretId('confluence', 'api_token'),
};
for (const [field, secretId] of Object.entries(secretIds)) {
  const value = field === 'base_url' ? BASE_URL : field === 'email' ? EMAIL : TOKEN;
  await upsertSecret(token, PROJECT, secretId, value);
  console.log(`  ${secretId} ✔`); // value never printed
}

// ── 2. Grant the RE runtime service agent secret access ───────────────────────
console.log('\n═══ 2. Grant RE runtime secretmanager.secretAccessor ═══');
const pn = await (await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`, {
  headers: { Authorization: `Bearer ${token}` },
})).json() as { projectNumber?: string };
const member = `serviceAccount:service-${pn.projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
const role = 'roles/secretmanager.secretAccessor';
console.log(`  member: ${member}`);

const polRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
});
const policy = await polRes.json() as { bindings?: Array<{ role: string; members: string[] }> };
policy.bindings = policy.bindings ?? [];
const existing = policy.bindings.find((b) => b.role === role);
if (existing?.members.includes(member)) {
  console.log('  already granted');
} else {
  if (existing) existing.members.push(member);
  else policy.bindings.push({ role, members: [member] });
  const setRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:setIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  console.log(`  setIamPolicy ${setRes.status} ${setRes.ok ? '' : (await setRes.text()).slice(0, 200)}`);
}

// ── 3. Deploy with indexed store + live connector tool ────────────────────────
console.log('\n═══ 3. Deploy ADK agent (VertexAiSearchTool + live Confluence tool) ═══');
const resolved = await resolveDestination(PROJECT, token);
const dest = { ...resolved, engine: ENGINE };
const dep = await deployReasoningEngine(PROJECT, LOCATION, {
  name: 'e2e_live_confluence',
  displayName: DISPLAY,
  description: 'Indexed ITINFRA+SALES knowledge plus a live Confluence search tool.',
  model: 'gemini-2.5-flash',
  instruction: INSTRUCTION,
  tools: [],
  groundingDataStores: [dataStoreResourcePath(PROJECT, DS_ID)],
  // consumed by _build_live_connector_tool in scripts/adk_deploy.py
  liveConnectors: [{ id: 'confluence', kind: 'confluence', name: 'Confluence', secretIds }],
}, { timeoutMs: 20 * 60_000 });

console.log(`  ok=${dep.ok} ${dep.reasoningEngine ?? dep.error ?? ''}`);
if (!dep.ok || !dep.reasoningEngine) process.exit(1);
const reId = dep.reasoningEngine.split('/').pop()!;

const info = await getReasoningEngineMethods(PROJECT, token, reId, LOCATION);
console.log(`  framework=${info?.framework}  methods=${info?.methods.join(', ')}`);

// ── 4. Register into the engine ───────────────────────────────────────────────
console.log('\n═══ 4. Register into engine ═══');
const reg = await registerAdkAgent(dest, token, {
  reasoningEngine: dep.reasoningEngine,
  displayName: DISPLAY,
  description: 'Indexed ITINFRA+SALES knowledge plus live Confluence lookup.',
});
console.log(`  registered=${reg.registered} agentId=${reg.agentId ?? '-'} state=${reg.state ?? '-'} ${reg.error ?? ''}`);

// ── 5. Ask: indexed topic, then a LIVE-ONLY topic ─────────────────────────────
console.log('\n═══ 5. Ask questions ═══');
const sessionId = (await createAdkSession(PROJECT, token, reId, USER_ID, LOCATION)) ?? undefined;

const asks: Array<[string, string]> = [
  ['indexed (ITINFRA)', 'What is the VPN access process?'],
  ['LIVE ONLY (ENG space, not indexed)', 'What are the Python coding standards?'],
  ['LIVE ONLY (HR space, not indexed)', 'How many days of earned leave do I get?'],
  ['neither source', 'What is the price of a Tesla Model 3?'],
];

for (const [label, q] of asks) {
  const r = await chatWithAdkAgent(PROJECT, token, { reasoningEngineId: reId, message: q, userId: USER_ID, sessionId, location: LOCATION });
  console.log(`\n  [${label}]  Q: ${q}`);
  if (!r.ok) { console.log(`  FAIL ${r.error}`); continue; }
  console.log(`  toolInvoked=${r.usedSearchTool}`);
  console.log(`  A: ${(r.answer ?? '(empty)').slice(0, 450)}`);
}

console.log(`\n════ done ════
  reasoningEngine : ${reId}
  agent           : ${reg.agentId ?? '-'}  state=${reg.state ?? '-'}
  live connector  : confluence (creds in Secret Manager, read at call time)
`);
