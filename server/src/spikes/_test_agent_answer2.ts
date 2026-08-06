/**
 * Fixed: correct Discovery Engine API shapes for sessions + answer.
 * Run: cd server && npx tsx src/spikes/_test_agent_answer2.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT   = 'sonorous-lightning-t224x';
const GEMINI_ADMIN  = 'mia@cloudfuze.com';
const HOST          = 'https://discoveryengine.googleapis.com/v1alpha';
const DS_ID         = 'confluence-knowledge-agent-all';
const AGENT_ID      = '11632552002298015870';
const QUESTION      = 'What is the sick leave policy?';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const collBase   = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${dest.engine}`;
const assistBase = `${engineBase}/assistants/${dest.assistant}`;
const agentPath  = `${assistBase}/agents/${AGENT_ID}`;

console.log(`Q: "${QUESTION}"\n`);

// ── 1. Engine sessions with correct body ──────────────────────────────────────
console.log('═══ 1. Engine sessions (correct body) ═══');
const sessR = await fetch(`${engineBase}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ session: {} }),
});
const sessT = await sessR.text();
console.log(`Create session: ${sessR.status}`);
if (sessR.ok) {
  const sessJ = JSON.parse(sessT) as Record<string, unknown>;
  const sessId = String(sessJ['name']).split('/').pop()!;
  console.log(`Session ID: ${sessId}`);

  const ansR = await fetch(`${engineBase}/sessions/${sessId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { text: QUESTION },
      answerGenerationSpec: {
        modelSpec: { modelVersion: 'gemini-2.5-flash' },
        includeCitations: true,
      },
    }),
  });
  const ansT = await ansR.text();
  console.log(`Answer: ${ansR.status}`);
  if (ansR.ok) {
    const j = JSON.parse(ansT) as { answer?: { answerText?: string } };
    console.log(`\n✅ ANSWER:\n${j.answer?.answerText ?? ansT.slice(0, 500)}`);
  } else {
    console.log(`Error: ${ansT.slice(0, 400)}`);
  }
} else {
  console.log(`Error: ${sessT.slice(0, 300)}`);
}

// ── 2. DataStore :answer API (fixed fields) ───────────────────────────────────
console.log('\n═══ 2. DataStore :answer API ═══');
const dsAnsR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:answer`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: { text: QUESTION },
    answerGenerationSpec: {
      modelSpec: { modelVersion: 'gemini-2.5-flash' },
      includeCitations: true,
    },
    searchSpec: { searchParams: { maxReturnResults: 5 } },
  }),
});
const dsAnsT = await dsAnsR.text();
console.log(`Status: ${dsAnsR.status}`);
if (dsAnsR.ok) {
  const j = JSON.parse(dsAnsT) as { answer?: { answerText?: string } };
  console.log(`\n✅ ANSWER:\n${j.answer?.answerText ?? dsAnsT.slice(0, 500)}`);
} else {
  console.log(`Error: ${dsAnsT.slice(0, 400)}`);
}

// ── 3. Search with summary (fixed) ───────────────────────────────────────────
console.log('\n═══ 3. Search + AI summary (fixed) ═══');
const srchR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 5,
    contentSearchSpec: {
      summarySpec: {
        summaryResultCount: 5,
        modelSpec: { version: 'gemini-2.5-flash' },
        includeCitations: true,
      },
      snippetSpec: { returnSnippet: true },
    },
  }),
});
const srchT = await srchR.text();
console.log(`Status: ${srchR.status}`);
if (srchR.ok) {
  const j = JSON.parse(srchT) as {
    summary?: { summaryText?: string; summarySkippedReasons?: string[] };
    results?: Array<{ document?: { derivedStructData?: { title?: unknown } } }>;
  };
  if (j.summary?.summaryText) {
    console.log(`\n✅ AI SUMMARY:\n${j.summary.summaryText}`);
  } else if (j.summary?.summarySkippedReasons) {
    console.log(`Summary skipped: ${j.summary.summarySkippedReasons.join(', ')}`);
  }
  console.log(`\nMatched docs:`);
  for (const r of j.results ?? []) {
    const title = r.document?.derivedStructData?.['title'];
    console.log(`  📄 ${title ?? '(no title)'}`);
  }
} else {
  console.log(`Error: ${srchT.slice(0, 400)}`);
}

// ── 4. Agent :answer (try on the agent itself) ────────────────────────────────
console.log('\n═══ 4. Agent direct answer ═══');
const agAnsR = await fetch(`${agentPath}:answer`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { text: QUESTION } }),
});
const agAnsT = await agAnsR.text();
console.log(`Status: ${agAnsR.status}`);
if (agAnsR.ok) console.log(`✅ ${agAnsT.slice(0, 500)}`);
else console.log(`Error: ${agAnsT.slice(0, 300)}`);

// ── 5. List agent sessions (see what exists) ──────────────────────────────────
console.log('\n═══ 5. List existing sessions under engine ═══');
const listR = await fetch(`${engineBase}/sessions`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const listT = await listR.text();
console.log(`Status: ${listR.status}`);
if (listR.ok) {
  const j = JSON.parse(listT) as { sessions?: Array<Record<string, unknown>> };
  console.log(`Sessions found: ${j.sessions?.length ?? 0}`);
  for (const s of j.sessions ?? []) console.log(`  ${JSON.stringify(s).slice(0, 120)}`);
} else {
  console.log(`Error: ${listT.slice(0, 200)}`);
}
