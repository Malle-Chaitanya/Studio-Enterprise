/**
 * Zara's project: find RE for KB agent, fix Gemini model names, do RAG.
 * Run: cd server && npx tsx src/spikes/_test_zara_kb3.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const QUESTION = 'What is the sick leave policy?';
const VTXAI = 'https://us-central1-aiplatform.googleapis.com';

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
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;

// ── 1. List Reasoning Engines (Vertex AI Agent Engine) ─────────────────────────
console.log('═══ 1. Reasoning Engines in Zara\'s project ═══');
const reR = await fetch(
  `${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/reasoningEngines`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
const reT = await reR.text();
console.log(`Status: ${reR.status}`);
if (reR.ok) {
  const j = JSON.parse(reT) as { reasoningEngines?: Array<{ name: string; displayName?: string }> };
  for (const re of j.reasoningEngines ?? []) {
    const id = re.name.split('/').pop()!;
    console.log(`  ${id} (${re.displayName ?? '?'})`);
  }
  if ((j.reasoningEngines?.length ?? 0) === 0) console.log('  (none)');
} else {
  console.log(`Error: ${reT.slice(0, 300)}`);
}

// ── 2. Find valid Generative Language model ───────────────────────────────────
console.log('\n═══ 2. Generative Language API — find valid model ═══');
const genModels = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash-001',
];
let workingGenModel = '';
for (const model of genModels) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK only.' }] }] }),
    }
  );
  const t = await r.text();
  if (r.ok) {
    const j = JSON.parse(t) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const txt = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    console.log(`  ${model}: ✅ "${txt.slice(0, 20)}"`);
    workingGenModel = model;
    break;
  } else {
    const msg = (() => { try { return JSON.parse(t).error?.message; } catch { return t; } })();
    console.log(`  ${model}: ${r.status} — ${String(msg).slice(0, 80)}`);
  }
}

// ── 3. Find valid Vertex AI model ─────────────────────────────────────────────
console.log('\n═══ 3. Vertex AI — find valid model ═══');
const vtxModels = [
  'gemini-2.0-flash',
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-pro',
];
let workingVtxModel = '';
for (const model of vtxModels) {
  const r = await fetch(
    `${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say OK only.' }] }] }),
    }
  );
  const t = await r.text();
  if (r.ok) {
    console.log(`  ${model}: ✅`);
    workingVtxModel = model;
    break;
  } else {
    const msg = (() => { try { return JSON.parse(t).error?.message; } catch { return t; } })();
    console.log(`  ${model}: ${r.status} — ${String(msg).slice(0, 80)}`);
  }
}

// ── 4. RAG: search Confluence + call Gemini ────────────────────────────────────
const geminiModel = workingGenModel || workingVtxModel;
if (!geminiModel) {
  console.log('\nNo working Gemini model found — cannot do RAG.');
} else {
  console.log(`\n═══ 4. RAG via ${workingGenModel ? 'generativelanguage' : 'Vertex AI'} (${geminiModel}) ═══`);

  // Search data store
  const srchR = await fetch(`${collBase}/dataStores/cf-knowledge-eng-hr/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: QUESTION,
      pageSize: 3,
      contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 3 } },
    }),
  });
  const srchJ = await srchR.json() as {
    results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
  };

  const contextParts: string[] = [];
  for (const r of srchJ.results ?? []) {
    const sd = r.document?.derivedStructData ?? {};
    const title = sd['title'] as string | undefined ?? '';
    const snips = sd['snippets'] as Array<{ snippet?: string; snippet_status?: string }> | undefined ?? [];
    const snip = snips.filter(s => s.snippet_status === 'SUCCESS').map(s => s.snippet?.replace(/<[^>]+>/g, '') ?? '').join(' ');
    if (title || snip) contextParts.push(`[${title}]: ${snip.slice(0, 400)}`);
  }
  console.log(`Data store snippets retrieved: ${contextParts.length}`);
  for (const c of contextParts) console.log(`  → ${c.slice(0, 120)}`);

  if (contextParts.length > 0) {
    const prompt = `Answer this question using ONLY the knowledge base content below.

Knowledge base:
${contextParts.join('\n\n')}

Question: ${QUESTION}
Answer:`;

    let answer = '';
    if (workingGenModel) {
      const genR2 = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } }),
        }
      );
      if (genR2.ok) {
        const j = JSON.parse(await genR2.text()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        answer = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      }
    } else if (workingVtxModel) {
      const vtxR2 = await fetch(
        `${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${geminiModel}:generateContent`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1 },
          }),
        }
      );
      if (vtxR2.ok) {
        const j = JSON.parse(await vtxR2.text()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        answer = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      }
    }

    if (answer) {
      console.log(`\n✅ GEMINI ANSWER (grounded on Confluence knowledge base):\n${answer}`);
    } else {
      console.log('No answer returned from Gemini.');
    }
  }
}

// ── 5. Invoke KB-Grounding-Test-Agent via RE query endpoint ────────────────────
console.log('\n═══ 5. Invoke KB-Grounding-Test-Agent via REST ═══');
// The Agent Engine ID in the RE path corresponds to the agent's Agentspace ID
// or we need to find the RE resource ID
const KB_AGENT_RE_ID = '7284613592318946592';
const reQueryR = await fetch(
  `${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/reasoningEngines/${KB_AGENT_RE_ID}:query`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { query: QUESTION } }),
  }
);
const reQueryT = await reQueryR.text();
console.log(`Status: ${reQueryR.status}`);
if (reQueryR.ok) {
  console.log(`\n✅ RE RESPONSE:\n${reQueryT.slice(0, 600)}`);
} else {
  console.log(`Error: ${reQueryT.slice(0, 300)}`);
}
