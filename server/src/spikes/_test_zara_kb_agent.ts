/**
 * Test KB-Grounding-Test-Agent + Confluence Knowledge data store in Zara's project.
 * Run: cd server && npx tsx src/spikes/_test_zara_kb_agent.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const ZARA_EMAIL = 'zara@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const KB_AGENT_ID = '7284613592318946592'; // KB-Grounding-Test-Agent
const QUESTION = 'What is the sick leave policy?';

// Mint DWD token for zara
async function getZaraToken(scopes = ['https://www.googleapis.com/auth/cloud-platform']): Promise<string> {
  const keyRaw = (config.GOOGLE_SA_KEY_JSON?.trim())
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  // SA's own identity — no subject/impersonation; SA belongs to studio-enterprise-migration
  const client = new JWT({ email: key.client_email, key: key.private_key, scopes });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('No token');
  console.log(`Token minted as ${key.client_email} ✅`);
  return access_token;
}

// SA is from studio-enterprise-migration project — use its own identity, no DWD
const saToken = await getZaraToken(['https://www.googleapis.com/auth/cloud-platform']);
console.log('Using SA own identity (no impersonation needed — SA belongs to this project)');

// ── 1. Discover the engine in Zara's project ──────────────────────────────────
console.log('\n═══ 1. List engines in studio-enterprise-migration ═══');
const engR = await fetch(
  `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection/engines`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
const engJ = await engR.json() as { engines?: Array<{ name: string; displayName?: string; dataStoreIds?: string[] }> };
console.log(`Status: ${engR.status}`);
let engineId = '';
for (const e of engJ.engines ?? []) {
  const eid = e.name.split('/').pop()!;
  console.log(`  ${eid} (${e.displayName ?? '?'}) — datastores: ${(e.dataStoreIds ?? []).join(', ')}`);
  if (!engineId) engineId = eid;
}
if (!engineId) {
  console.log('No engines found — trying known engine ID from URL');
  engineId = 'gemini-enterprise-17847887_1784788734248';
}

const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${engineId}`;
console.log(`Using engine: ${engineId}`);

// ── 2. List data stores — find Confluence Knowledge ───────────────────────────
console.log('\n═══ 2. Data stores in Zara\'s project ═══');
const dsR = await fetch(`${collBase}/dataStores`, { headers: { Authorization: `Bearer ${saToken}` } });
const dsJ = await dsR.json() as { dataStores?: Array<{ name: string; displayName?: string; solutionTypes?: string[]; contentConfig?: string }> };
let confluenceDsId = '';
for (const ds of dsJ.dataStores ?? []) {
  const id = ds.name.split('/').pop()!;
  const isConfl = (ds.displayName ?? '').toLowerCase().includes('confluence');
  const marker = isConfl ? '👈 CONFLUENCE' : '';
  console.log(`  ${id} (${ds.displayName ?? '?'}) ${marker}`);
  console.log(`    type: ${(ds.solutionTypes ?? []).join(',')} content: ${ds.contentConfig ?? '?'}`);
  if (isConfl) confluenceDsId = id;
}

// ── 3. List agents — find KB-Grounding-Test-Agent ─────────────────────────────
console.log('\n═══ 3. Agents in Zara\'s project ═══');
const assistR = await fetch(`${engineBase}/assistants`, { headers: { Authorization: `Bearer ${saToken}` } });
const assistJ = await assistR.json() as { assistants?: Array<{ name: string; displayName?: string }> };
let assistantId = '';
for (const a of assistJ.assistants ?? []) {
  const aid = a.name.split('/').pop()!;
  console.log(`  assistant: ${aid} (${a.displayName ?? '?'})`);
  assistantId = aid;
}
if (!assistantId) assistantId = 'default_assistant';
console.log(`Using assistant: ${assistantId}`);

const agentBase = `${engineBase}/assistants/${assistantId}/agents`;
const agentsListR = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
const agentsJ = await agentsListR.json() as { agents?: Array<{ name: string; displayName?: string; state?: string }> };
let kbAgentId = '';
for (const a of agentsJ.agents ?? []) {
  const aid = a.name.split('/').pop()!;
  const isKb = (a.displayName ?? '').toLowerCase().includes('kb') || (a.displayName ?? '').toLowerCase().includes('grounding') || aid === KB_AGENT_ID;
  console.log(`  ${aid} (${a.displayName ?? '?'}) state=${a.state ?? '?'} ${isKb ? '👈 KB AGENT' : ''}`);
  if (isKb) kbAgentId = aid;
}
if (!kbAgentId) kbAgentId = KB_AGENT_ID;

// ── 4. Check KB-Grounding-Test-Agent definition ───────────────────────────────
console.log(`\n═══ 4. KB-Grounding-Test-Agent (${kbAgentId}) definition ═══`);
const agentR = await fetch(`${agentBase}/${kbAgentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
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
  console.log(`dataStoreSpecs: ${specs.length > 0 ? '✅ ' + specs.map(s => String(s['dataStore']).split('/').pop()).join(', ') : '❌ none'}`);
  if (specs.length === 0) {
    // Check if it's an ADK/Reasoning Engine agent
    const reConfig = j['reasoningEngineConfig'] as Record<string, unknown> | undefined;
    if (reConfig) console.log(`reasoningEngineConfig: ${JSON.stringify(reConfig).slice(0, 200)}`);
    console.log(`Full agent (partial): ${agentT.slice(0, 400)}`);
  }
}

// ── 5. Search Confluence Knowledge data store ─────────────────────────────────
if (confluenceDsId) {
  console.log(`\n═══ 5. Search Confluence Knowledge data store (${confluenceDsId}) ═══`);
  const srchR = await fetch(`${collBase}/dataStores/${confluenceDsId}/servingConfigs/default_config:search`, {
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
  const srchT = await srchR.text();
  console.log(`Status: ${srchR.status}`);
  if (srchR.ok) {
    const j = JSON.parse(srchT) as {
      summary?: { summaryText?: string; summarySkippedReasons?: string[] };
      results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
    };
    if (j.summary?.summaryText && !j.summary.summaryText.includes('could not be generated')) {
      console.log(`\n✅ AI SUMMARY:\n${j.summary.summaryText}`);
    } else {
      console.log(`Summary: ${j.summary?.summarySkippedReasons?.join(', ') ?? j.summary?.summaryText ?? 'none'}`);
    }
    console.log(`Results (${j.results?.length ?? 0}):`);
    for (const r of j.results ?? []) {
      const sd = r.document?.derivedStructData ?? {};
      const title = (sd['title'] as string | { stringValue?: string } | undefined);
      const titleStr = typeof title === 'string' ? title : title?.stringValue ?? Object.keys(sd)[0];
      const snippets = sd['snippets'] as Array<{ snippet?: string | { stringValue?: string }; snippet_status?: string }> | undefined;
      const snip = snippets?.[0]?.snippet;
      const snipStr = (typeof snip === 'string' ? snip : snip?.stringValue ?? '').replace(/<[^>]+>/g, '');
      console.log(`  📄 ${titleStr}: ${snipStr.slice(0, 150)}`);
    }
  } else {
    console.log(`Error: ${srchT.slice(0, 300)}`);
  }
}

// ── 6. Engine :answer on Zara's engine ────────────────────────────────────────
console.log(`\n═══ 6. Engine :answer (${engineId}) ═══`);
const ansR2 = await fetch(`${engineBase}/servingConfigs/default_search:answer`, {
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
const ansT2 = await ansR2.text();
console.log(`Status: ${ansR2.status}`);
if (ansR2.ok) {
  const j = JSON.parse(ansT2) as { answer?: { answerText?: string; answerSkippedReasons?: string[] } };
  const text = j.answer?.answerText ?? '(no answer)';
  const skipped = j.answer?.answerSkippedReasons;
  if (!text.includes('could not be generated')) {
    console.log(`\n✅ ANSWER:\n${text}`);
  } else {
    console.log(`Answer: ${text}`);
    if (skipped) console.log(`Skipped reasons: ${skipped.join(', ')}`);
  }
} else {
  console.log(`Error: ${ansT2.slice(0, 300)}`);
}

// ── 7. Check if Vertex AI / Gemini API enabled in Zara's project ──────────────
console.log('\n═══ 7. Test Vertex AI API in Zara\'s project ═══');
const vtxR = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/gemini-2.0-flash-001:generateContent`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Say "Vertex AI works" and nothing else.' }] }],
    }),
  }
);
const vtxT = await vtxR.text();
console.log(`Vertex AI: ${vtxR.status}`);
if (vtxR.ok) {
  const j = JSON.parse(vtxT) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  console.log(`✅ ${j.candidates?.[0]?.content?.parts?.[0]?.text ?? vtxT.slice(0, 100)}`);
} else {
  console.log(`Error: ${vtxT.slice(0, 200)}`);
}
