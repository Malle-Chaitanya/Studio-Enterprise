/**
 * Check engine data stores, engine :answer full response, and RAG via Vertex Gemini.
 * Run: cd server && npx tsx src/spikes/_test_agent_answer6.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const DS_ID = 'confluence-knowledge-agent-all';
const QUESTION = 'What is the sick leave policy?';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);

const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${dest.engine}`;

console.log(`Engine: ${dest.engine}\n`);

// ── 1. Check engine's dataStoreIds ────────────────────────────────────────────
console.log('═══ 1. Engine dataStoreIds ═══');
const engR = await fetch(engineBase, { headers: { Authorization: `Bearer ${saToken}` } });
const engJ = await engR.json() as { dataStoreIds?: string[]; displayName?: string };
console.log(`Engine: ${engJ.displayName}`);
console.log(`DataStoreIds (${engJ.dataStoreIds?.length ?? 0}):`);
for (const id of engJ.dataStoreIds ?? []) {
  const marker = id === DS_ID ? '👈 OUR STORE' : '';
  console.log(`  ${id} ${marker}`);
}
const ourStoreAttached = engJ.dataStoreIds?.includes(DS_ID) ?? false;
console.log(`Our data store attached: ${ourStoreAttached ? '✅ YES' : '❌ NO'}`);

// ── 2. Engine :answer — full response ────────────────────────────────────────
console.log('\n═══ 2. Engine :answer — full response ═══');
const ansR = await fetch(`${engineBase}/servingConfigs/default_search:answer`, {
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
console.log(`Status: ${ansR.status}`);
if (ansR.ok) {
  const j = JSON.parse(ansT) as Record<string, unknown>;
  console.log(JSON.stringify(j, null, 2).slice(0, 1200));
} else {
  console.log(`Error: ${ansT.slice(0, 300)}`);
}

// ── 3. Engine search with correct data store format ────────────────────────────
console.log('\n═══ 3. Engine search — correct dataStore format ═══');
const dsResourcePath = `projects/${GCP_PROJECT_NUM}/locations/global/collections/default_collection/dataStores/${DS_ID}`;
const engSearchR = await fetch(`${engineBase}/servingConfigs/default_search:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 5,
    dataStoreSpecs: [{ dataStore: dsResourcePath }],
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
    console.log(`Summary: ${j.summary?.summarySkippedReasons?.join(', ') ?? 'none'}`);
    console.log(`Docs matched: ${j.results?.length ?? 0}`);
    for (const r of j.results?.slice(0, 3) ?? []) {
      console.log(`  ${JSON.stringify(r.document?.derivedStructData).slice(0, 100)}`);
    }
  }
} else {
  console.log(`Error: ${engSearchT.slice(0, 300)}`);
}

// ── 4. RAG: fetch actual doc content, then ask Gemini ─────────────────────────
console.log('\n═══ 4. RAG via Vertex AI Gemini (fixed) ═══');
// Get search results WITH snippet spec
const rawR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 3,
    contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 3 } },
  }),
});
const rawJ = await rawR.json() as {
  results?: Array<{
    document?: {
      name?: string;
      derivedStructData?: Record<string, unknown>;
    };
  }>;
};
console.log(`Raw search: ${rawR.status}, results: ${rawJ.results?.length ?? 0}`);

// Log full first result to understand structure
if ((rawJ.results?.length ?? 0) > 0) {
  console.log(`First result structure: ${JSON.stringify(rawJ.results![0]?.document?.derivedStructData, null, 2).slice(0, 600)}`);
}

const contextParts: string[] = [];
for (const r of rawJ.results ?? []) {
  const sd = r.document?.derivedStructData ?? {};
  // Try multiple possible field names
  const title =
    (sd['title'] as { stringValue?: string } | undefined)?.stringValue ??
    (sd['title'] as string | undefined) ??
    String(sd['id'] ?? r.document?.name?.split('/').pop() ?? '');
  const snippets =
    (sd['snippets'] as Array<{ snippet?: { stringValue?: string } | string }> | undefined) ?? [];
  const snippetText = snippets
    .map(s => {
      if (typeof s === 'object' && s.snippet) {
        return typeof s.snippet === 'string' ? s.snippet : s.snippet.stringValue ?? '';
      }
      return '';
    })
    .join(' ')
    .replace(/<[^>]+>/g, '')
    .slice(0, 500);
  if (title || snippetText) {
    contextParts.push(`Document: ${title}\nContent: ${snippetText || '(no snippet returned)'}`);
  }
}

// If no snippets, fetch actual document content
if (contextParts.length === 0 && (rawJ.results?.length ?? 0) > 0) {
  console.log('No snippets in results — fetching document content directly...');
  for (const r of (rawJ.results ?? []).slice(0, 2)) {
    const docName = r.document?.name;
    if (!docName) continue;
    const docR = await fetch(`${HOST}/${docName.replace(/^projects\//, 'projects/')}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const docT = await docR.text();
    if (docR.ok) {
      const docJ = JSON.parse(docT) as { content?: { rawBytes?: string }; id?: string };
      const rawContent = docJ.content?.rawBytes
        ? Buffer.from(docJ.content.rawBytes, 'base64').toString('utf8').replace(/<[^>]+>/g, '').slice(0, 400)
        : '(no raw content)';
      contextParts.push(`Document: ${docJ.id}\nContent: ${rawContent}`);
    }
  }
}

console.log(`Context parts: ${contextParts.length}`);

if (contextParts.length > 0) {
  const geminiR = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/gemini-2.0-flash-001:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: `Answer this question using only the provided company knowledge base content:

${contextParts.join('\n\n---\n\n')}

Question: ${QUESTION}

Provide a clear, specific answer based on the knowledge base. If not found, say so.` }],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }),
    }
  );
  const geminiT = await geminiR.text();
  console.log(`Vertex Gemini: ${geminiR.status}`);
  if (geminiR.ok) {
    const j = JSON.parse(geminiT) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const answer = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
    console.log(`\n✅ GEMINI ANSWER (grounded on Confluence):\n${answer}`);
  } else {
    console.log(`Error: ${geminiT.slice(0, 400)}`);
  }
} else {
  console.log('No context retrieved — cannot call Gemini.');
}
