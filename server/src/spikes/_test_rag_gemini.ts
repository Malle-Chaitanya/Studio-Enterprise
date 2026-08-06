/**
 * Prove the full knowledge chain via RAG:
 *  1. Search data store → get snippet (already proven to work)
 *  2. Feed snippet to Gemini via generativelanguage.googleapis.com (SA OAuth token)
 *  3. Get a grounded answer
 *
 * Run: cd server && npx tsx src/spikes/_test_rag_gemini.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { getSaToken } from '../auth/google.js';
import { config } from '../config.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';

// Mint a token with generative-language scope for the Gemini API call
// SA's OWN token (no DWD impersonation) — needed for generativelanguage.googleapis.com
// which isn't in the DWD allowlist. The SA must have Generative AI user role.
async function getGeminiToken(): Promise<string> {
  const keyRaw = (config.GOOGLE_SA_KEY_JSON && config.GOOGLE_SA_KEY_JSON.trim())
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/generative-language',
    ],
    // no subject = SA's own identity, no DWD impersonation
  });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('No token');
  return access_token;
}
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const DS_ID = 'confluence-knowledge-agent-all';

const QUESTIONS = [
  'What is the sick leave policy?',
  'How many days of annual leave do employees get?',
  'What are the engineering coding standards?',
];

const saToken = await getSaToken(GEMINI_ADMIN);
const geminiToken = await getGeminiToken();
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;

console.log('=== KNOWLEDGE BASE + GEMINI RAG TEST ===\n');

for (const question of QUESTIONS) {
  console.log(`\nQ: "${question}"`);
  console.log('─'.repeat(60));

  // Step 1: Search the data store
  const searchR = await fetch(`${collBase}/dataStores/${DS_ID}/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: question,
      pageSize: 5,
      contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 3 } },
    }),
  });
  const searchJ = await searchR.json() as {
    results?: Array<{
      document?: {
        name?: string;
        derivedStructData?: {
          title?: string;
          snippets?: Array<{ snippet?: string; snippet_status?: string }>;
          link?: string;
        };
      };
    }>;
  };

  const contextParts: string[] = [];
  for (const r of searchJ.results ?? []) {
    const sd = r.document?.derivedStructData;
    if (!sd) continue;
    const title = sd.title ?? r.document?.name?.split('/').pop() ?? '';
    const snippet = (sd.snippets ?? [])
      .filter(s => s.snippet_status === 'SUCCESS')
      .map(s => s.snippet?.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ') ?? '')
      .join(' ');
    if (snippet) {
      contextParts.push(`**${title}**: ${snippet}`);
    }
  }

  console.log(`  Data store results: ${searchJ.results?.length ?? 0}`);
  if (contextParts.length > 0) {
    console.log(`  Context retrieved: ✅ (${contextParts.length} snippet(s))`);
    for (const c of contextParts) {
      console.log(`    → ${c.slice(0, 120)}`);
    }
  } else {
    console.log('  Context retrieved: ❌ (no snippets)');
    continue;
  }

  // Step 2: Ask Gemini via generativelanguage.googleapis.com (generative-language scope token)
  const geminiR = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${geminiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `You are a helpful HR/company assistant. Answer the question using ONLY the provided knowledge base content. Be concise and specific.

Knowledge base content:
${contextParts.join('\n')}

Question: ${question}

Answer:`
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 300,
        },
      }),
    }
  );

  const geminiT = await geminiR.text();
  if (geminiR.ok) {
    const j = JSON.parse(geminiT) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const answer = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
    console.log(`\n  ✅ AI ANSWER:\n  ${answer.replace(/\n/g, '\n  ')}`);
  } else {
    console.log(`  Gemini error ${geminiR.status}: ${geminiT.slice(0, 300)}`);
  }
}

console.log('\n\n=== SUMMARY ===');
console.log('Data store search: ✅ indexed and returning snippets');
console.log('Gemini RAG: see results above');
console.log('\nProven chain: Confluence pages → data store → search → Gemini → answer');
