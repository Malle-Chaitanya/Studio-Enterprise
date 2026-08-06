/**
 * Engine-level :answer with NO dataStoreSpecs restriction — searches every store the
 * engine serves. Proves whether grounded, cited answers are available over the API
 * today (no UI publish click, no agent resource involved), and shows WHICH documents
 * ground each answer so we know which data store actually served it.
 *
 * Run: cd server && npx tsx src/spikes/_probe_engine_answer_all.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const AGENT_ID = '10065544401725915235';

const QUESTIONS = [
  'What is the sick leave policy?',
  'How many days of earned leave do I get?',
  'What are the Python coding standards?',
  'How do engineers deploy to production?',
  'What is the maternity leave policy?',
];

const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
  ? config.GOOGLE_SA_KEY_JSON
  : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(keyRaw) as { client_email: string; private_key: string };
const jwt = new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const { access_token } = await jwt.authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const engineBase = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}`;

// agent's own instruction becomes the answer preamble — persona travels with the query
const ar = await fetch(`${engineBase}/assistants/default_assistant/agents/${AGENT_ID}`, { headers: h });
const aj = await ar.json() as Record<string, any>;
const rootId = aj?.lowCodeAgentDefinition?.rootAgentId;
const instruction: string = (aj?.lowCodeAgentDefinition?.nodes ?? []).find((n: any) => n.id === rootId)?.llmAgentNode?.instruction ?? '';
console.log(`preamble from agent (${instruction.length} chars)\n`);

let grounded = 0;
for (const q of QUESTIONS) {
  const r = await fetch(`${engineBase}/servingConfigs/default_search:answer`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      query: { text: q },
      answerGenerationSpec: {
        includeCitations: true,
        ignoreLowRelevantContent: true,
        promptSpec: { preamble: instruction },
        modelSpec: { modelVersion: 'stable' },
      },
    }),
  });
  const t = await r.text();
  if (!r.ok) { console.log(`Q: ${q}\n  FAIL ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 200)}\n`); continue; }
  const j = JSON.parse(t) as {
    answer?: {
      state?: string; answerText?: string; citations?: unknown[];
      references?: Array<{ chunkInfo?: { documentMetadata?: { title?: string; uri?: string } }; unstructuredDocumentInfo?: { title?: string; uri?: string } }>;
    };
  };
  const a = j.answer ?? {};
  const srcs = (a.references ?? []).map((x) => {
    const m = x.chunkInfo?.documentMetadata ?? x.unstructuredDocumentInfo ?? {};
    return m.title || m.uri || '?';
  });
  const uniq = [...new Set(srcs)];
  console.log(`Q: ${q}`);
  console.log(`  state=${a.state} citations=${(a.citations ?? []).length} sources=${uniq.join(' | ') || '(none)'}`);
  console.log(`  A: ${(a.answerText ?? '(empty)').replace(/\s+/g, ' ').slice(0, 260)}\n`);
  if ((a.citations ?? []).length > 0) grounded++;
}
console.log(`═══ ${grounded}/${QUESTIONS.length} grounded with citations ═══`);
