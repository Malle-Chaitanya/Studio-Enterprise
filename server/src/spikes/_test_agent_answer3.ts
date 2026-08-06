/**
 * Session-first: use existing UI sessions + fix model version for search.
 * Run: cd server && npx tsx src/spikes/_test_agent_answer3.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const DS_ID = 'confluence-knowledge-agent-all';
const QUESTION = 'What is the sick leave policy?';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);

const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${dest.engine}`;

console.log(`Q: "${QUESTION}"\n`);

// ── 1. Get an existing session and POST to it ─────────────────────────────────
console.log('═══ 1. POST question to existing session ═══');
const listR = await fetch(`${engineBase}/sessions?pageSize=1&orderBy=update_time+desc`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const listJ = await listR.json() as { sessions?: Array<{ name: string }> };
const firstSess = listJ.sessions?.[0];
if (firstSess) {
  const sessId = firstSess.name.split('/').pop()!;
  console.log(`Using session: ${sessId}`);
  const ansR = await fetch(`${engineBase}/sessions/${sessId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { text: QUESTION },
      answerGenerationSpec: {
        modelSpec: { modelVersion: 'stable' },
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
}

// ── 2. Create session with correct minimal body ───────────────────────────────
console.log('\n═══ 2. Session create — various bodies ═══');
const bodies = [
  { label: 'empty {}', body: {} },
  { label: 'userPseudoId', body: { userPseudoId: 'test-user-1' } },
  { label: 'turnCount:0', body: { turnCount: 0 } },
];
for (const { label, body } of bodies) {
  const r = await fetch(`${engineBase}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (r.ok) {
    const j = JSON.parse(t) as Record<string, unknown>;
    console.log(`${label} → 200 name=${j['name']}`);
    // Ask question in this new session
    const sessId = String(j['name']).split('/').pop()!;
    const ansR2 = await fetch(`${engineBase}/sessions/${sessId}/answers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { text: QUESTION },
        answerGenerationSpec: { modelSpec: { modelVersion: 'stable' }, includeCitations: true },
        groundingConfig: { dataStoreSpecs: [{ dataStoreId: DS_ID }] },
      }),
    });
    const ansT2 = await ansR2.text();
    console.log(`  → answer ${ansR2.status}: ${ansT2.slice(0, 200)}`);
    break; // stop after first success
  } else {
    console.log(`${label} → ${r.status}: ${t.slice(0, 120)}`);
  }
}

// ── 3. Search + extractive answers (no AI summary needed) ─────────────────────
console.log('\n═══ 3. Search extractive answers (no model) ═══');
const exR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 5,
    contentSearchSpec: {
      extractiveContentSpec: {
        maxExtractiveAnswerCount: 3,
        maxExtractiveSegmentCount: 3,
      },
      snippetSpec: { returnSnippet: true, maxSnippetCount: 2 },
    },
  }),
});
const exT = await exR.text();
console.log(`Status: ${exR.status}`);
if (exR.ok) {
  const j = JSON.parse(exT) as {
    results?: Array<{
      document?: {
        derivedStructData?: Record<string, unknown>;
      };
    }>;
  };
  for (const r of j.results ?? []) {
    const sd = r.document?.derivedStructData ?? {};
    const title = (sd['title'] as { stringValue?: string } | undefined)?.stringValue ?? '(no title)';
    const snippets = sd['snippets'] as Array<{ snippet?: { stringValue?: string } }> | undefined;
    const snippet = snippets?.[0]?.snippet?.stringValue ?? '';
    const answers = sd['extractive_answers'] as Array<{ content?: { stringValue?: string } }> | undefined;
    const exAns = answers?.[0]?.content?.stringValue ?? '';
    console.log(`\n📄 ${title}`);
    if (snippet) console.log(`  Snippet: ${snippet.replace(/<[^>]+>/g, '').slice(0, 200)}`);
    if (exAns) console.log(`  ✅ Extractive answer: ${exAns.slice(0, 300)}`);
  }
} else {
  console.log(`Error: ${exT.slice(0, 300)}`);
}

// ── 4. Search + summary with stable model ────────────────────────────────────
console.log('\n═══ 4. Search + AI summary (stable model) ═══');
const sumR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 5,
    contentSearchSpec: {
      summarySpec: {
        summaryResultCount: 5,
        modelSpec: { version: 'stable' },
        includeCitations: true,
      },
      snippetSpec: { returnSnippet: true },
    },
  }),
});
const sumT = await sumR.text();
console.log(`Status: ${sumR.status}`);
if (sumR.ok) {
  const j = JSON.parse(sumT) as {
    summary?: { summaryText?: string; summarySkippedReasons?: string[] };
    results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
  };
  if (j.summary?.summaryText) {
    console.log(`\n✅ AI SUMMARY:\n${j.summary.summaryText}`);
  } else {
    console.log(`Summary skipped: ${j.summary?.summarySkippedReasons?.join(', ') ?? 'none'}`);
    console.log(`Docs: ${j.results?.length ?? 0}`);
    for (const r of j.results ?? []) {
      const sd = r.document?.derivedStructData ?? {};
      const title = (sd['title'] as { stringValue?: string } | undefined)?.stringValue;
      console.log(`  📄 ${title ?? '(no title)'}`);
    }
  }
} else {
  console.log(`Error: ${sumT.slice(0, 300)}`);
}

// ── 5. Check existing session content (did UI sessions have answers?) ─────────
console.log('\n═══ 5. Peek at most recent session turns ═══');
if (firstSess) {
  const sessId = firstSess.name.split('/').pop()!;
  const sessDetailR = await fetch(`${engineBase}/sessions/${sessId}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const sessDetailT = await sessDetailR.text();
  console.log(`Session detail: ${sessDetailR.status}`);
  if (sessDetailR.ok) {
    const j = JSON.parse(sessDetailT) as Record<string, unknown>;
    const turns = j['turns'] as Array<Record<string, unknown>> | undefined;
    console.log(`Turns: ${turns?.length ?? 0}`);
    for (const t of (turns ?? []).slice(0, 2)) {
      const q = (t['query'] as Record<string, unknown> | undefined);
      const a = (t['answer'] as Record<string, unknown> | undefined);
      console.log(`  Q: ${JSON.stringify(q?.['text']).slice(0, 80)}`);
      console.log(`  A: ${String(a?.['answerText'] ?? '(no answer)').slice(0, 100)}`);
    }
  }
}
