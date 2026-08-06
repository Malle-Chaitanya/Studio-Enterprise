/**
 * Invoke KB-Grounding-Test-Agent via Reasoning Engine REST + RAG with correct scope.
 * Run: cd server && npx tsx src/spikes/_test_zara_kb4.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const VTXAI = 'https://us-central1-aiplatform.googleapis.com';
const QUESTION = 'What is the sick leave policy?';

// KB-Grounding-Test-Agent RE IDs from the list (try most recent first — higher ID = more recent)
const RE_IDS = [
  '7337403381230600192',  // KB-Grounding-Test-Agent (most recent in list)
  '7089916507957755904',
  '823509470192599040',
  '4888500715103715328',
  '833009250656583680',
  '7506217998512816128',
  '2063688217579749376',
];

async function getSaToken(scopes: string[]): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const client = new JWT({ email: key.client_email, key: key.private_key, scopes });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('No token');
  return access_token;
}

const saToken = await getSaToken(['https://www.googleapis.com/auth/cloud-platform']);
const genToken = await getSaToken([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language',
]);
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;

// ── 1. Invoke KB-Grounding-Test-Agent RE ─────────────────────────────────────
console.log('═══ 1. KB-Grounding-Test-Agent via Reasoning Engine REST ═══');
let reAnswer = '';
for (const reId of RE_IDS) {
  // Try :query first (ADK RE format)
  const queryR = await fetch(
    `${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/reasoningEngines/${reId}:query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { query: QUESTION } }),
    }
  );
  const queryT = await queryR.text();
  if (queryR.ok) {
    console.log(`\n✅ RE ${reId} :query → 200`);
    console.log(queryT.slice(0, 600));
    reAnswer = queryT;
    break;
  }
  // Try :streamQuery
  const sqR = await fetch(
    `${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/reasoningEngines/${reId}:streamQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { query: QUESTION } }),
    }
  );
  const sqT = await sqR.text();
  if (sqR.ok) {
    console.log(`\n✅ RE ${reId} :streamQuery → 200`);
    console.log(sqT.slice(0, 600));
    reAnswer = sqT;
    break;
  }
  const errJ = (() => { try { return JSON.parse(queryT); } catch { return null; } })();
  const msg = errJ?.error?.message ?? queryT;
  console.log(`  RE ${reId}: query=${queryR.status} streamQuery=${sqR.status} — ${String(msg).slice(0, 80)}`);
}
if (!reAnswer) {
  console.log('\nAll RE IDs tried — none responded. Agent may not be invocable via REST (class_method bug).');
}

// ── 2. generativelanguage.googleapis.com with generative-language scope ────────
console.log('\n═══ 2. Generative Language API (with generative-language scope) ═══');
const genModels = ['gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
let workingModel = '';
for (const model of genModels) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${genToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Say "works" only.' }] }] }),
    }
  );
  if (r.ok) {
    const j = JSON.parse(await r.text()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const txt = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    console.log(`  ${model}: ✅ "${txt.slice(0, 30)}"`);
    workingModel = model;
    break;
  } else {
    const t = await r.text();
    const msg = (() => { try { return JSON.parse(t).error?.message; } catch { return t; } })();
    console.log(`  ${model}: ${r.status} — ${String(msg).slice(0, 80)}`);
  }
}

// ── 3. RAG: Confluence data store → Gemini ────────────────────────────────────
if (workingModel) {
  console.log(`\n═══ 3. RAG: Confluence search → Gemini (${workingModel}) ═══`);
  const srchR = await fetch(`${collBase}/dataStores/cf-knowledge-eng-hr/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: QUESTION,
      pageSize: 5,
      contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 3 } },
    }),
  });
  const srchJ = await srchR.json() as {
    results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }>;
  };

  const context: string[] = [];
  for (const r of srchJ.results ?? []) {
    const sd = r.document?.derivedStructData ?? {};
    const title = sd['title'] as string ?? '(unknown)';
    const snips = sd['snippets'] as Array<{ snippet?: string; snippet_status?: string }> ?? [];
    const snip = snips.filter(s => s.snippet_status === 'SUCCESS')
      .map(s => s.snippet?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&') ?? '')
      .join(' ');
    if (snip) context.push(`[${title}]: ${snip}`);
  }
  console.log(`  Retrieved ${context.length} snippet(s)`);
  for (const c of context) console.log(`  → ${c.slice(0, 120)}`);

  if (context.length > 0) {
    const gemR = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${workingModel}:generateContent`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${genToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a helpful company assistant. Answer using ONLY the provided knowledge base.

Knowledge base content:
${context.join('\n\n')}

Question: ${QUESTION}

Answer concisely:`
            }]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
      }
    );
    if (gemR.ok) {
      const j = JSON.parse(await gemR.text()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const answer = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
      console.log(`\n✅ GEMINI ANSWER (grounded on Confluence knowledge base):\n${answer}`);
    } else {
      console.log(`Gemini error: ${(await gemR.text()).slice(0, 200)}`);
    }

    // Test multiple questions
    const questions = ['How many days of earned leave?', 'What are the Python coding standards?'];
    for (const q of questions) {
      const srchR2 = await fetch(`${collBase}/dataStores/cf-knowledge-eng-hr/servingConfigs/default_config:search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, pageSize: 3, contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 2 } } }),
      });
      const srchJ2 = await srchR2.json() as { results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }> };
      const ctx2: string[] = [];
      for (const r of srchJ2.results ?? []) {
        const sd = r.document?.derivedStructData ?? {};
        const title = sd['title'] as string ?? '';
        const snips = sd['snippets'] as Array<{ snippet?: string; snippet_status?: string }> ?? [];
        const snip = snips.filter(s => s.snippet_status === 'SUCCESS').map(s => s.snippet?.replace(/<[^>]+>/g, '') ?? '').join(' ');
        if (snip) ctx2.push(`[${title}]: ${snip}`);
      }
      if (ctx2.length === 0) { console.log(`\nQ: "${q}" → no results`); continue; }
      const gemR2 = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${workingModel}:generateContent`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${genToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Answer using ONLY this knowledge base:\n${ctx2.join('\n')}\n\nQ: ${q}\nA:` }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
          }),
        }
      );
      if (gemR2.ok) {
        const j = JSON.parse(await gemR2.text()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        console.log(`\nQ: "${q}"\n✅ A: ${j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)'}`);
      }
    }
  }
}
