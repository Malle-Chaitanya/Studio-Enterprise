/**
 * Proof: invoke the migrated agent over the API without any UI publish click.
 *
 * The low-code agent resource itself is not invocable (state is readOnly, no publish
 * method, and streamAssist's agentsSpec.agentId is accepted but ignored — a bogus id
 * behaves identically). What IS invocable is the engine-level answer API, which
 * reaches the same data store the agent is wired to:
 *
 *   engines/*\/servingConfigs/default_search:answer
 *     + answerGenerationSpec.promptSpec.preamble   <- the agent's own instruction
 *     + searchSpec.searchParams.dataStoreSpecs     <- the agent's own data store
 *
 * That composition = the agent's persona + the agent's grounding + citations.
 *
 * Run: cd server && npx tsx src/spikes/_probe_agent_answer.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const PROJECT = 'studio-enterprise-migration';
const PROJECT_NUM = '231705905417';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const AGENT_ID = '10065544401725915235';
const DS_ID = 'cf-knowledge-eng-hr';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

const DS_PATH = `projects/${PROJECT_NUM}/locations/global/collections/default_collection/dataStores/${DS_ID}`;

const QUESTIONS = [
  'What is the sick leave policy?',
  'How many days of earned leave do I get?',
  'What are the Python coding standards?',
  'How do engineers deploy to production?',
  'What is the maternity leave policy?',
  'What is the refund policy for enterprise customers?', // out-of-scope: must refuse
];

async function getSaToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const c = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const { access_token } = await c.authorize();
  if (!access_token) throw new Error('no token');
  return access_token;
}

const token = await getSaToken();
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const collBase = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${ENGINE}`;

// ── 1. Read the agent's own instruction out of the agent resource ──────────────
const ar = await fetch(`${engineBase}/assistants/default_assistant/agents/${AGENT_ID}`, { headers: h });
const aj = await ar.json() as Record<string, any>;
const node = (aj?.lowCodeAgentDefinition?.nodes ?? []).find((n: any) => n.id === aj?.lowCodeAgentDefinition?.rootAgentId);
const instruction: string = node?.llmAgentNode?.instruction ?? '';
const dsFromAgent: string = node?.llmAgentNode?.dataStoreSpecs?.specs?.[0]?.dataStore ?? '(none)';

console.log('=== agent under test ===');
console.log(`  displayName : ${aj['displayName']}`);
console.log(`  state       : ${aj['state']}   sharing=${JSON.stringify(aj['sharingConfig'] ?? {})}`);
console.log(`  dataStore   : ${dsFromAgent.split('/').pop()}`);
console.log(`  instruction : ${instruction.slice(0, 120)}…`);

// ── 2. Ask every question through the engine answer API ───────────────────────
let ok = 0;
let refused = 0;
for (const q of QUESTIONS) {
  const r = await fetch(`${engineBase}/servingConfigs/default_search:answer`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      query: { text: q },
      searchSpec: { searchParams: { dataStoreSpecs: [{ dataStore: dsFromAgent !== '(none)' ? dsFromAgent : DS_PATH }], maxReturnResults: 5 } },
      answerGenerationSpec: {
        includeCitations: true,
        ignoreLowRelevantContent: true,
        promptSpec: { preamble: instruction },
        modelSpec: { modelVersion: 'stable' },
      },
    }),
  });
  const t = await r.text();
  if (!r.ok) { console.log(`\nQ: ${q}\n  FAIL ${r.status}  ${t.replace(/\s+/g, ' ').slice(0, 260)}`); continue; }
  const j = JSON.parse(t) as { answer?: { state?: string; answerText?: string; citations?: unknown[]; references?: unknown[] } };
  const a = j.answer ?? {};
  const cites = (a.citations ?? []).length;
  const srcs = (a.references ?? []).length;
  const text = a.answerText ?? '(empty)';
  console.log(`\nQ: ${q}`);
  console.log(`  state=${a.state}  citations=${cites}  references=${srcs}`);
  console.log(`  A: ${text.replace(/\s+/g, ' ').slice(0, 320)}`);
  if (cites > 0) ok++; else refused++;
}

console.log(`\n═══ ${ok} grounded / ${refused} ungrounded-or-refused of ${QUESTIONS.length} ═══`);
