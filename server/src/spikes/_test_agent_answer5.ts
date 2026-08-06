/**
 * Try: search via engine serving config (not data store), then RAG via Vertex AI.
 * Run: cd server && npx tsx src/spikes/_test_agent_answer5.ts
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

// ── 1. Search through ENGINE serving config (not data store) ──────────────────
console.log('═══ 1. Engine-level search :search ═══');
const engSearchR = await fetch(`${engineBase}/servingConfigs/default_search:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 5,
    dataStoreSpecs: [{ dataStore: `${collBase}/dataStores/${DS_ID}` }],
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
const engSearchT = await engSearchR.text();
console.log(`Status: ${engSearchR.status}`);
if (engSearchR.ok) {
  const j = JSON.parse(engSearchT) as {
    summary?: { summaryText?: string; summarySkippedReasons?: string[] };
    results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
  };
  if (j.summary?.summaryText) {
    console.log(`\n✅ AI SUMMARY:\n${j.summary.summaryText}`);
  } else {
    console.log(`Summary skipped: ${j.summary?.summarySkippedReasons?.join(', ')}`);
    console.log(`Docs: ${j.results?.length ?? 0}`);
  }
} else {
  console.log(`Error: ${engSearchT.slice(0, 400)}`);
}

// ── 2. Engine search without data store filter (uses all attached stores) ─────
console.log('\n═══ 2. Engine search — all stores, AI summary ═══');
const engAllR = await fetch(`${engineBase}/servingConfigs/default_search:search`, {
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
const engAllT = await engAllR.text();
console.log(`Status: ${engAllR.status}`);
if (engAllR.ok) {
  const j = JSON.parse(engAllT) as {
    summary?: { summaryText?: string; summarySkippedReasons?: string[] };
    results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
  };
  if (j.summary?.summaryText) {
    console.log(`\n✅ AI SUMMARY (engine-wide):\n${j.summary.summaryText}`);
  } else {
    console.log(`Summary skipped: ${j.summary?.summarySkippedReasons?.join(', ')}`);
    console.log(`Docs: ${j.results?.length ?? 0}`);
    for (const r of j.results ?? []) {
      const sd = r.document?.derivedStructData ?? {};
      const title = (sd['title'] as { stringValue?: string } | undefined)?.stringValue ?? Object.keys(sd)[0];
      console.log(`  📄 ${title}`);
    }
  }
} else {
  console.log(`Error: ${engAllT.slice(0, 300)}`);
}

// ── 3. Engine :answer endpoint ────────────────────────────────────────────────
console.log('\n═══ 3. Engine :answer endpoint ═══');
const engAnsR = await fetch(`${engineBase}/servingConfigs/default_search:answer`, {
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
const engAnsT = await engAnsR.text();
console.log(`Status: ${engAnsR.status}`);
if (engAnsR.ok) {
  const j = JSON.parse(engAnsT) as { answer?: { answerText?: string } };
  console.log(`\n✅ ANSWER:\n${j.answer?.answerText ?? engAnsT.slice(0, 500)}`);
} else {
  console.log(`Error: ${engAnsT.slice(0, 400)}`);
}

// ── 4. RAG: search → feed to Vertex AI Gemini ────────────────────────────────
console.log('\n═══ 4. RAG via Vertex AI Gemini ═══');
// First get search results
const rawSearchR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: QUESTION, pageSize: 3 }),
});
const rawSearchJ = await rawSearchR.json() as {
  results?: Array<{
    document?: {
      derivedStructData?: Record<string, unknown>;
      content?: { rawBytes?: string };
    };
  }>;
};

// Collect snippets
const snippetTexts: string[] = [];
for (const r of rawSearchJ.results ?? []) {
  const sd = r.document?.derivedStructData ?? {};
  const title = (sd['title'] as { stringValue?: string } | undefined)?.stringValue ?? '';
  const snippets = sd['snippets'] as Array<{ snippet?: { stringValue?: string } }> | undefined;
  const snippet = snippets?.[0]?.snippet?.stringValue?.replace(/<[^>]+>/g, '') ?? '';
  if (title || snippet) {
    snippetTexts.push(`[${title}]: ${snippet}`);
  }
}
console.log(`Retrieved ${snippetTexts.length} snippets from data store`);
if (snippetTexts.length > 0) {
  // Call Vertex AI Gemini
  const geminiR = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: `You are a helpful assistant. Answer the question using ONLY the provided context.

Context from the company knowledge base:
${snippetTexts.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Question: ${QUESTION}

Answer based on the context above. If the answer is not in the context, say "Not found in knowledge base."`
          }]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 400 },
      }),
    }
  );
  const geminiT = await geminiR.text();
  console.log(`Vertex AI Gemini: ${geminiR.status}`);
  if (geminiR.ok) {
    const j = JSON.parse(geminiT) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const answer = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
    console.log(`\n✅ GEMINI ANSWER (grounded on Confluence data):\n${answer}`);
  } else {
    console.log(`Error: ${geminiT.slice(0, 300)}`);
  }
} else {
  console.log('No snippets to send to Gemini.');
}

// ── 5. Check agentspace-hybrid confluence data store search (with LLM?) ──────
console.log('\n═══ 5. Agentspace-hybrid Confluence search (with AI summary?) ═══');
const hybridDsId = 'agentspace-hybrid-atlassian-confluence_page1534';
const hybridR = await fetch(`${collBase}/dataStores/${hybridDsId}/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 3,
    contentSearchSpec: {
      summarySpec: {
        summaryResultCount: 3,
        modelSpec: { version: 'stable' },
        includeCitations: true,
      },
    },
  }),
});
const hybridT = await hybridR.text();
console.log(`Status: ${hybridR.status}`);
if (hybridR.ok) {
  const j = JSON.parse(hybridT) as {
    summary?: { summaryText?: string; summarySkippedReasons?: string[] };
    results?: unknown[];
  };
  if (j.summary?.summaryText) {
    console.log(`\n✅ HYBRID AI SUMMARY:\n${j.summary.summaryText}`);
  } else {
    console.log(`Summary: ${j.summary?.summarySkippedReasons?.join(', ') ?? 'none'}`);
    console.log(`Docs: ${j.results?.length ?? 0}`);
  }
} else {
  console.log(`Error: ${hybridT.slice(0, 300)}`);
}
