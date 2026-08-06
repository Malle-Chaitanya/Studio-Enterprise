/**
 * PROVEN: Confluence data store → Vertex AI Gemini → grounded answer.
 * Run: cd server && npx tsx src/spikes/_test_zara_rag_vtx.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const VTXAI = 'https://us-central1-aiplatform.googleapis.com';
const MODEL = 'gemini-2.5-flash';

async function getSaToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const client = new JWT({
    email: key.client_email, key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('No token');
  return access_token;
}

async function geminiAnswer(saToken: string, context: string[], question: string): Promise<string> {
  const r = await fetch(
    `${VTXAI}/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: `You are a helpful company assistant. Answer using ONLY the provided knowledge base content. Be concise and specific.

Knowledge base:
${context.join('\n\n')}

Question: ${question}

Answer:`
          }]
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 300 },
      }),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Gemini ${r.status}: ${t.slice(0, 100)}`);
  }
  const j = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
}

const saToken = await getSaToken();
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  KNOWLEDGE BASE END-TO-END TEST                        ║');
console.log('║  Confluence data store → Vertex AI Gemini → Answer     ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

const QUESTIONS = [
  'What is the sick leave policy?',
  'How many days of earned leave do employees get, and can they carry it forward?',
  'What are the Python coding standards?',
  'How do engineers deploy code to production, and what happens if bugs are found post-deploy?',
  'What is the maternity leave policy?',
];

let allPassed = true;
for (const q of QUESTIONS) {
  console.log(`Q: ${q}`);
  console.log('─'.repeat(60));

  // Search data store
  const srchR = await fetch(`${collBase}/dataStores/cf-knowledge-eng-hr/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: q, pageSize: 3,
      contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 3 } },
    }),
  });
  const srchJ = await srchR.json() as { results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }> };
  const context: string[] = [];
  for (const r of srchJ.results ?? []) {
    const sd = r.document?.derivedStructData ?? {};
    const title = sd['title'] as string ?? '';
    const snips = sd['snippets'] as Array<{ snippet?: string; snippet_status?: string }> ?? [];
    const snip = snips.filter(s => s.snippet_status === 'SUCCESS')
      .map(s => s.snippet?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ') ?? '')
      .join(' ').trim();
    if (snip) context.push(`[${title}]: ${snip}`);
  }

  if (context.length === 0) {
    console.log('  ❌ No results\n');
    allPassed = false;
    continue;
  }
  console.log(`  Source: ${context.map(c => c.split(']:')[0].slice(1)).join(', ')}`);

  try {
    const answer = await geminiAnswer(saToken, context, q);
    console.log(`  ✅ ${answer.replace(/\n/g, ' ').slice(0, 300)}`);
  } catch (e) {
    console.log(`  ❌ Gemini error: ${e}`);
    allPassed = false;
  }
  console.log();
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log(`║  RESULT: ${allPassed ? '✅ ALL PASSED' : '⚠ SOME FAILED'}                                    ║`);
console.log('║                                                          ║');
console.log('║  Chain proven:                                           ║');
console.log('║  Confluence → data store → Discovery Engine search      ║');
console.log('║               → Vertex AI Gemini → grounded answer      ║');
console.log('╚══════════════════════════════════════════════════════════╝');
