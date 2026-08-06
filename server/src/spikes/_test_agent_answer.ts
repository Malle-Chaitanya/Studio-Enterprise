/**
 * Test if the data store + agent actually work — multiple API approaches.
 * Run: cd server && npx tsx src/spikes/_test_agent_answer.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT     = 'sonorous-lightning-t224x';
const GEMINI_ADMIN    = 'mia@cloudfuze.com';
const HOST            = 'https://discoveryengine.googleapis.com/v1alpha';
const DATA_STORE_ID   = 'confluence-knowledge-agent-all';
const AGENT_ID        = '11632552002298015870';
const QUESTION        = 'What is the sick leave policy?';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const collBase  = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${dest.engine}`;
const assistBase = `${engineBase}/assistants/${dest.assistant}`;
const agentBase  = `${assistBase}/agents`;

console.log(`Question: "${QUESTION}"\n`);

// ── 1. Data store :answer (AI-grounded answer directly from data store) ───────
console.log('═══ 1. DataStore :answer API (grounded AI answer) ═══');
const ansUrl = `${collBase}/dataStores/${DATA_STORE_ID}/servingConfigs/default_config:answer`;
const ansR = await fetch(ansUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: { text: QUESTION },
    session: 'projects/-/locations/global/collections/default_collection/dataStores/-/sessions/-',
    answerGenerationSpec: {
      modelSpec: { modelVersion: 'gemini-2.5-flash' },
      groundingSpec: { includeGroundingSupports: true },
      includeCitations: true,
    },
    searchSpec: {
      searchParams: { maxReturnResults: 5 },
    },
  }),
});
const ansT = await ansR.text();
console.log(`Status: ${ansR.status}`);
if (ansR.ok) {
  const j = JSON.parse(ansT) as {
    answer?: { answerText?: string; citations?: unknown[] };
    session?: unknown;
  };
  console.log(`\n✅ ANSWER:\n${j.answer?.answerText ?? '(no answer text)'}`);
  console.log(`Citations: ${j.answer?.citations?.length ?? 0}`);
} else {
  console.log(`Error: ${ansT.slice(0, 400)}`);
}

// ── 2. Engine-level sessions (correct path for Agentspace agents) ─────────────
console.log('\n═══ 2. Engine-level sessions API ═══');
const engSessR = await fetch(`${engineBase}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
const engSessT = await engSessR.text();
console.log(`Create session: ${engSessR.status}`);
if (engSessR.ok) {
  const sessJ = JSON.parse(engSessT) as Record<string, unknown>;
  const sessName = String(sessJ['name']);
  const sessId   = sessName.split('/').pop()!;
  console.log(`Session: ${sessId}`);
  // Now query the session
  const turnR = await fetch(`${engineBase}/sessions/${sessId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: QUESTION } }),
  });
  const turnT = await turnR.text();
  console.log(`Answer status: ${turnR.status}`);
  if (turnR.ok) {
    const j = JSON.parse(turnT) as { answer?: { answerText?: string } };
    console.log(`\n✅ ANSWER:\n${j.answer?.answerText ?? turnT.slice(0, 400)}`);
  } else {
    console.log(`Error: ${turnT.slice(0, 200)}`);
  }
} else {
  console.log(`Error: ${engSessT.slice(0, 200)}`);
}

// ── 3. Assistant-level sessions ───────────────────────────────────────────────
console.log('\n═══ 3. Assistant-level sessions API ═══');
const assistSessR = await fetch(`${assistBase}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
console.log(`Create session: ${assistSessR.status}`);
if (assistSessR.ok) {
  const j = await assistSessR.json() as Record<string, unknown>;
  const sessId = String(j['name']).split('/').pop()!;
  console.log(`Session: ${sessId}`);
  const ansR2 = await fetch(`${assistBase}/sessions/${sessId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: QUESTION } }),
  });
  const ansT2 = await ansR2.text();
  console.log(`Answer: ${ansR2.status} — ${ansT2.slice(0, 300)}`);
} else {
  console.log(`Error: ${(await assistSessR.text()).slice(0, 200)}`);
}

// ── 4. Agent-specific :streamGenerateContent (Vertex AI path) ─────────────────
console.log('\n═══ 4. Direct agent query (v1beta Vertex path) ═══');
const vertexUrl = `https://discoveryengine.googleapis.com/v1beta/projects/${GCP_PROJECT}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents/${AGENT_ID}:answer`;
const vR = await fetch(vertexUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { text: QUESTION } }),
});
const vT = await vR.text();
console.log(`Status: ${vR.status}`);
if (vR.ok) console.log(`✅ ${vT.slice(0, 400)}`);
else console.log(`Error: ${vT.slice(0, 300)}`);

// ── 5. DataStore search + answer combo (what the agent does under the hood) ───
console.log('\n═══ 5. Search + AI answer from data store (proves grounding works) ═══');
const combo = await fetch(`${collBase}/dataStores/${DATA_STORE_ID}/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 5,
    contentSearchSpec: {
      summarySpec: {
        summaryResultCount: 5,
        modelPromptSpec: {
          preamble: 'Answer the question using only the provided documents. Be specific and cite the document title.',
        },
        modelSpec: { version: 'gemini-2.5-flash' },
        includeCitations: true,
        ignoreAdversarialQuery: false,
        returnExtractiveSegmentScore: true,
      },
      extractiveContentSpec: { maxExtractiveAnswerCount: 3 },
    },
  }),
});
const comboT = await combo.text();
console.log(`Status: ${combo.status}`);
if (combo.ok) {
  const j = JSON.parse(comboT) as {
    summary?: { summaryText?: string; summarySkippedReasons?: string[] };
    results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
  };
  console.log(`Results: ${j.results?.length ?? 0}`);
  if (j.summary?.summaryText) {
    console.log(`\n✅ AI ANSWER FROM DATA STORE:\n${j.summary.summaryText}`);
  } else {
    console.log(`Summary skipped: ${j.summary?.summarySkippedReasons?.join(', ') ?? 'unknown'}`);
    for (const r of j.results ?? []) {
      const sd = r.document?.derivedStructData ?? {};
      console.log(`  📄 ${JSON.stringify(sd).slice(0, 120)}`);
    }
  }
} else {
  console.log(`Error: ${comboT.slice(0, 300)}`);
}
