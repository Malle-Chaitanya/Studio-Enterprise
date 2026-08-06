/**
 * End-to-end proof: Confluence creds + chosen spaces -> data store -> engine attach
 * -> low-code agent -> grounded answers with citations.
 *
 * Exists because the previous attempt (_create_cf_kb_agent.ts) skipped the engine
 * attach, which the dataStoreSpecs path silently requires — the engine rejects any
 * store missing from engine.dataStoreIds with "not found in the engine". This runs
 * the whole chain through the real services so the product path is what gets proven.
 *
 * Creds: set CONFLUENCE_TOKEN in server/.env (git-ignored). Email/base URL below.
 *
 *   npx tsx src/spikes/_e2e_confluence_agent.ts --list                  # show spaces
 *   npx tsx src/spikes/_e2e_confluence_agent.ts "Engineering" "HR"      # build it
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { migrateConfluenceToDataStore } from '../services/confluenceMigrator.js';
import { attachDataStoreToEngine } from '../services/geminiDataStore.js';
import { resolveDestination } from '../services/gemini.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const BASE_URL = process.env.CONFLUENCE_BASE_URL ?? 'https://aicloudfuze.atlassian.net';
const EMAIL = process.env.CONFLUENCE_EMAIL ?? 'sujana.manapuram@cloudfuze.com';
const TOKEN = process.env.CONFLUENCE_TOKEN ?? '';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

const args = process.argv.slice(2);
const LIST_ONLY = args.includes('--list');
const SPACES = args.filter((a) => !a.startsWith('--'));

if (!TOKEN) {
  console.error('Missing CONFLUENCE_TOKEN. Add it to server/.env (git-ignored):\n  CONFLUENCE_TOKEN=<atlassian api token>');
  process.exit(1);
}

async function saToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const j = new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const { access_token } = await j.authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

const auth = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`, 'utf-8').toString('base64');

// ── 1. Verify creds + list spaces ─────────────────────────────────────────────
console.log('═══ 1. Confluence auth ═══');
const me = await fetch(`${BASE_URL}/wiki/rest/api/user/current`, { headers: { Authorization: auth, Accept: 'application/json' } });
if (!me.ok) {
  console.error(`  auth FAILED ${me.status}: ${(await me.text()).slice(0, 200)}`);
  process.exit(1);
}
const user = await me.json() as { displayName?: string };
console.log(`  ok — ${user.displayName} @ ${BASE_URL}`);

const sr = await fetch(`${BASE_URL}/wiki/rest/api/space?limit=100&type=global`, { headers: { Authorization: auth, Accept: 'application/json' } });
const sj = await sr.json() as { results?: Array<{ key: string; name: string }> };
console.log(`\n  available spaces (${(sj.results ?? []).length}):`);
for (const s of sj.results ?? []) console.log(`    [${s.key}] ${s.name}`);

if (LIST_ONLY) process.exit(0);
if (SPACES.length === 0) {
  console.error('\nPass one or more space DISPLAY NAMES (as shown above), or --list.');
  process.exit(1);
}
console.log(`\n  selected: ${SPACES.join(', ')}`);

// ── 2. Crawl + index into a NEW data store ────────────────────────────────────
const token = await saToken();
const resolved = await resolveDestination(PROJECT, token);
// resolveDestination can pick a search-only engine (e.g. cf-knowledge-search) whose
// assistants/agents endpoint 404s — agents only exist on the gemini-enterprise engine.
// E2E_ENGINE pins the agent-hosting engine until resolveDestination is fixed.
const dest = process.env.E2E_ENGINE ? { ...resolved, engine: process.env.E2E_ENGINE } : resolved;
console.log(`\n═══ 2. Destination ═══\n  project=${dest.project} engine=${dest.engine} assistant=${dest.assistant}`);
if (process.env.E2E_ENGINE && resolved.engine !== dest.engine) {
  console.log(`  (resolveDestination returned "${resolved.engine}" — overridden by E2E_ENGINE)`);
}

// agentSourceId seeds the data store id; keep it stable so re-runs are idempotent
const SOURCE_ID = process.env.E2E_SOURCE_ID ?? 'e2e-cf-demo';
console.log(`\n═══ 3. Crawl Confluence -> data store (sourceId=${SOURCE_ID}) ═══`);
const mig = await migrateConfluenceToDataStore(PROJECT, token, SOURCE_ID, {
  base_url: BASE_URL, email: EMAIL, api_token: TOKEN, spaceNames: SPACES,
});
console.log(`  dataStoreId : ${mig.dataStoreId ?? '(none)'}`);
console.log(`  spaces      : ${mig.spaceCount}   pages: ${mig.pageCount}`);
if (mig.error) console.log(`  error       : ${mig.error}`);
if (!mig.dataStoreId || !mig.resourcePath) process.exit(1);

// ── 4. Attach to engine — the step the earlier spike skipped ───────────────────
console.log(`\n═══ 4. Attach data store to engine ═══`);
const att = await attachDataStoreToEngine(dest, token, mig.dataStoreId);
console.log(`  ok=${att.ok} ${att.error ?? ''}`);
console.log(`  engine dataStoreIds: ${JSON.stringify(att.dataStoreIds ?? [])}`);
if (!att.ok) process.exit(1);

// ── 5. Create the low-code agent wired to that store ──────────────────────────
const DISPLAY = process.env.E2E_AGENT_NAME ?? `Confluence Agent (${SPACES.join(' + ')})`;
const INSTRUCTION =
  'You are a company assistant grounded in the connected Confluence knowledge base. ' +
  'Answer only from the connected data store. Always cite the Confluence page title. ' +
  'If the answer is not in the knowledge base, say: "I do not have that information in the knowledge base."';

const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

console.log(`\n═══ 5. Create agent "${DISPLAY}" ═══`);
const listR = await fetch(agentBase, { headers: h });
const listJ = await listR.json() as { agents?: Array<{ name: string; displayName?: string; state?: string }> };
let agentId = listJ.agents?.find((a) => a.displayName === DISPLAY)?.name.split('/').pop();

if (agentId) {
  console.log(`  already exists: ${agentId} (idempotent, reusing)`);
} else {
  const node = {
    id: 'root_agent',
    displayName: DISPLAY,
    llmAgentNode: {
      description: `Answers from Confluence spaces: ${SPACES.join(', ')}.`,
      model: 'gemini-2.5-flash',
      instruction: INSTRUCTION,
      subAgentIds: [] as string[],
      dataStoreSpecs: { specs: [{ dataStore: mig.resourcePath }] },
    },
  };
  const cr = await fetch(agentBase, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      displayName: DISPLAY,
      description: `Confluence knowledge agent (${SPACES.join(', ')}) — ${mig.pageCount} pages.`,
      icon: {},
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent', nodes: [node], deployedNodes: [node], deployedRootAgentId: 'root_agent',
        draftDisplayName: DISPLAY, draftDescription: DISPLAY, draftStarterPrompts: [], draftIcon: { content: '' },
        agentFiles: [], draftSchedules: [], deployedSchedules: [],
      },
    }),
  });
  const ct = await cr.text();
  if (!cr.ok) { console.error(`  create FAILED ${cr.status}: ${ct.slice(0, 300)}`); process.exit(1); }
  const cj = JSON.parse(ct) as Record<string, unknown>;
  agentId = String(cj['name']).split('/').pop();
  console.log(`  created ${agentId}  state=${cj['state']}`);
}

// share org-wide (writable; state itself is readOnly and needs a console click)
const shR = await fetch(`${agentBase}/${agentId}?updateMask=sharingConfig`, {
  method: 'PATCH', headers: h, body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`  sharingConfig=ALL_USERS -> ${shR.status}`);

// ── 6. Prove it answers, grounded, restricted to its own store ────────────────
console.log(`\n═══ 6. Verify grounded answers (retries while the attach propagates) ═══`);
const engineBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;
const QUESTIONS = (process.env.E2E_QUESTIONS ?? 'What is this space about?|Summarise the main topics covered').split('|');

async function ask(q: string): Promise<{ ok: boolean; retry: boolean; line: string }> {
  const r = await fetch(`${engineBase}/servingConfigs/default_search:answer`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      query: { text: q },
      searchSpec: { searchParams: { dataStoreSpecs: [{ dataStore: mig.resourcePath }], maxReturnResults: 5 } },
      answerGenerationSpec: {
        includeCitations: true, ignoreLowRelevantContent: true,
        promptSpec: { preamble: INSTRUCTION }, modelSpec: { modelVersion: 'stable' },
      },
    }),
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, retry: t.includes('not found in the engine'), line: `${r.status} ${t.replace(/\s+/g, ' ').slice(0, 160)}` };
  const j = JSON.parse(t) as { answer?: { state?: string; answerText?: string; citations?: unknown[] } };
  const a = j.answer ?? {};
  const cites = (a.citations ?? []).length;
  return { ok: cites > 0, retry: false, line: `state=${a.state} citations=${cites} :: ${(a.answerText ?? '').replace(/\s+/g, ' ').slice(0, 220)}` };
}

for (const q of QUESTIONS) {
  let res = await ask(q);
  for (let i = 0; i < 10 && res.retry; i++) {
    await new Promise((r) => setTimeout(r, 60_000));
    console.log(`  (retry ${i + 1}: attach not propagated yet)`);
    res = await ask(q);
  }
  console.log(`\n  Q: ${q}\n  ${res.ok ? 'GROUNDED' : 'NOT GROUNDED'} — ${res.line}`);
}

console.log(`\n════ done ════
  data store : ${mig.dataStoreId}  (${mig.pageCount} pages from ${mig.spaceCount} space(s))
  engine     : ${dest.engine}  (store attached)
  agent      : ${agentId}  "${DISPLAY}"  sharing=ALL_USERS, state=PRIVATE
  UI chat still needs one admin Publish click — state is a readOnly field.
`);
