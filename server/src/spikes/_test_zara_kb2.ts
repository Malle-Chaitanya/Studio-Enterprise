/**
 * Zara's project: find KB agent in gemini-enterprise engine, test Vertex AI RAG.
 * Run: cd server && npx tsx src/spikes/_test_zara_kb2.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const GEMINI_ENGINE = 'gemini-enterprise-17847887_1784788734248';
const KB_AGENT_ID = '7284613592318946592';
const QUESTION = 'What is the sick leave policy?';

async function getSaToken(scopes = ['https://www.googleapis.com/auth/cloud-platform']): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const client = new JWT({ email: key.client_email, key: key.private_key, scopes });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('No token');
  return access_token;
}

const saToken = await getSaToken();
const saTokenWide = await getSaToken([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language',
]);

const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const geminiEngBase = `${collBase}/engines/${GEMINI_ENGINE}`;

console.log('SA project: studio-enterprise-migration\n');

// ── 1. Find assistant under gemini-enterprise engine ─────────────────────────
console.log('═══ 1. Assistants in gemini-enterprise engine ═══');
const assistR = await fetch(`${geminiEngBase}/assistants`, { headers: { Authorization: `Bearer ${saToken}` } });
const assistJ = await assistR.json() as { assistants?: Array<{ name: string; displayName?: string }> };
let assistantId = 'default_assistant';
for (const a of assistJ.assistants ?? []) {
  const aid = a.name.split('/').pop()!;
  console.log(`  ${aid} (${a.displayName ?? '?'})`);
  assistantId = aid;
}
console.log(`Using: ${assistantId}`);

const agentBase = `${geminiEngBase}/assistants/${assistantId}/agents`;

// ── 2. KB-Grounding-Test-Agent definition ─────────────────────────────────────
console.log(`\n═══ 2. KB-Grounding-Test-Agent (${KB_AGENT_ID}) ═══`);
const agentR = await fetch(`${agentBase}/${KB_AGENT_ID}`, { headers: { Authorization: `Bearer ${saToken}` } });
const agentT = await agentR.text();
console.log(`Status: ${agentR.status}`);
if (agentR.ok) {
  const j = JSON.parse(agentT) as Record<string, unknown>;
  console.log(`displayName: ${j['displayName']}`);
  console.log(`state      : ${j['state']}`);
  const lcd = j['lowCodeAgentDefinition'] as Record<string, unknown> | undefined;
  const nodes = (lcd?.['nodes'] as Array<Record<string, unknown>>) ?? [];
  const rootNode = nodes.find(n => n['id'] === 'root_agent');
  const llmNode = rootNode?.['llmAgentNode'] as Record<string, unknown> | undefined;
  const dsSpecs = llmNode?.['dataStoreSpecs'] as Record<string, unknown> | undefined;
  const specs = (dsSpecs?.['specs'] as Array<Record<string, unknown>>) ?? [];
  console.log(`dataStoreSpecs: ${specs.length > 0
    ? '✅ ' + specs.map(s => String(s['dataStore']).split('/').pop()).join(', ')
    : '❌ none'}`);
  const instr = llmNode?.['instruction'] as string | undefined;
  if (instr) console.log(`instruction: ${instr.slice(0, 100)}`);
} else {
  console.log(`Error: ${agentT.slice(0, 200)}`);
  // List all agents
  console.log('\n  Listing all agents in this engine...');
  const listR = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
  const listJ = await listR.json() as { agents?: Array<{ name: string; displayName?: string; state?: string }> };
  for (const a of listJ.agents ?? []) {
    const aid = a.name.split('/').pop()!;
    console.log(`  ${aid} (${a.displayName ?? '?'}) state=${a.state ?? '?'}`);
  }
}

// ── 3. Search cf-knowledge-eng-hr (linked to cf-knowledge-search engine) ──────
console.log('\n═══ 3. cf-knowledge-eng-hr data store search ═══');
const cfR = await fetch(`${collBase}/dataStores/cf-knowledge-eng-hr/servingConfigs/default_config:search`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: QUESTION,
    pageSize: 5,
    contentSearchSpec: {
      snippetSpec: { returnSnippet: true, maxSnippetCount: 3 },
      summarySpec: {
        summaryResultCount: 5,
        modelSpec: { version: 'stable' },
        includeCitations: true,
      },
    },
  }),
});
const cfT = await cfR.text();
console.log(`Status: ${cfR.status}`);
if (cfR.ok) {
  const j = JSON.parse(cfT) as {
    summary?: { summaryText?: string; summarySkippedReasons?: string[] };
    results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
  };
  if (j.summary?.summaryText && !j.summary.summaryText.includes('could not be generated')) {
    console.log(`\n✅ AI SUMMARY:\n${j.summary.summaryText}`);
  } else {
    console.log(`Summary: ${j.summary?.summarySkippedReasons?.join(', ') ?? j.summary?.summaryText ?? 'none'}`);
  }
  for (const r of j.results ?? []) {
    const sd = r.document?.derivedStructData ?? {};
    const title = sd['title'] as string | undefined ?? '(no title)';
    const snips = sd['snippets'] as Array<{ snippet?: string }> | undefined ?? [];
    const snip = snips[0]?.snippet?.replace(/<[^>]+>/g, '') ?? '';
    console.log(`  📄 ${title}: ${snip.slice(0, 150)}`);
  }
}

// ── 4. cf-knowledge-search engine :answer ─────────────────────────────────────
console.log('\n═══ 4. cf-knowledge-search engine :answer ═══');
const cfEngBase = `${collBase}/engines/cf-knowledge-search`;
const cfAnsR = await fetch(`${cfEngBase}/servingConfigs/default_search:answer`, {
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
const cfAnsT = await cfAnsR.text();
console.log(`Status: ${cfAnsR.status}`);
if (cfAnsR.ok) {
  const j = JSON.parse(cfAnsT) as { answer?: { answerText?: string; answerSkippedReasons?: string[] } };
  const txt = j.answer?.answerText ?? '(no text)';
  if (!txt.includes('could not be generated')) {
    console.log(`\n✅ ANSWER:\n${txt}`);
  } else {
    console.log(`Text: ${txt}`);
    console.log(`Skipped: ${j.answer?.answerSkippedReasons?.join(', ')}`);
  }
} else {
  console.log(`Error: ${cfAnsT.slice(0, 300)}`);
}

// ── 5. Vertex AI — try different model names ───────────────────────────────────
console.log('\n═══ 5. Vertex AI Gemini (various models) ═══');
const models = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash',
  'gemini-1.5-flash-002',
  'gemini-pro',
];
for (const model of models) {
  const vtxR = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Say "OK" only.' }] }],
      }),
    }
  );
  const vtxT = await vtxR.text();
  if (vtxR.ok) {
    console.log(`  ${model}: ✅ WORKS`);
    // Now do RAG
    console.log(`\n  Running RAG with ${model}...`);
    // Reuse snippet from step 3
    const ragR = await fetch(
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{
              text: `Answer using only the provided knowledge base content.

Knowledge base: Sick Leave policy - Employees get 10 days sick leave per year, no carry forward. Casual Leave 12 days. Earned Leave 15 days (up to 30 carry forward).

Question: ${QUESTION}

Answer:`
            }]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
      }
    );
    const ragT = await ragR.text();
    if (ragR.ok) {
      const j = JSON.parse(ragT) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const answer = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
      console.log(`  ✅ GEMINI ANSWER: ${answer}`);
    }
    break;
  } else {
    const errMsg = JSON.parse(vtxT).error?.message ?? vtxT.slice(0, 80);
    console.log(`  ${model}: ${vtxR.status} — ${errMsg.slice(0, 80)}`);
  }
}

// ── 6. Generative Language API with wide scopes ────────────────────────────────
console.log('\n═══ 6. generativelanguage.googleapis.com ═══');
const genR = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saTokenWide}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Say "Gemini API works" only.' }] }],
    }),
  }
);
const genT = await genR.text();
console.log(`Status: ${genR.status}`);
if (genR.ok) {
  const j = JSON.parse(genT) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  console.log(`✅ ${j.candidates?.[0]?.content?.parts?.[0]?.text ?? genT.slice(0, 100)}`);
} else {
  console.log(`Error: ${genT.slice(0, 200)}`);
}
