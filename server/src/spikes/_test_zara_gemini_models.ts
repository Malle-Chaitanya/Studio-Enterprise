/**
 * Find available Gemini models + try Vertex AI Gemini endpoint.
 * Run: cd server && npx tsx src/spikes/_test_zara_gemini_models.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const QUESTION = 'What is the sick leave policy?';

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

const saToken = await getSaToken([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language',
]);
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;

// ── 1. List available Generative Language models ──────────────────────────────
console.log('═══ 1. Available models on generativelanguage.googleapis.com ═══');
for (const ver of ['v1', 'v1beta']) {
  const r = await fetch(`https://generativelanguage.googleapis.com/${ver}/models`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const t = await r.text();
  console.log(`  ${ver}: ${r.status}`);
  if (r.ok) {
    const j = JSON.parse(t) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    const genModels = (j.models ?? []).filter(m => m.supportedGenerationMethods?.includes('generateContent'));
    console.log(`  generateContent-capable models (${genModels.length}):`);
    for (const m of genModels.slice(0, 10)) {
      console.log(`    ${m.name} (${m.displayName ?? '?'})`);
    }
    break;
  } else {
    console.log(`  Error: ${t.slice(0, 100)}`);
  }
}

// ── 2. Try Vertex AI with correct model + check IAM ───────────────────────────
console.log('\n═══ 2. Vertex AI — check IAM and try models ═══');
const vtxToken = await getSaToken(['https://www.googleapis.com/auth/cloud-platform']);

// Check SA's IAM roles in the project
const iamR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${GCP_PROJECT}:getIamPolicy`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${vtxToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ options: { requestedPolicyVersion: 1 } }),
  }
);
const iamT = await iamR.text();
console.log(`IAM policy: ${iamR.status}`);
if (iamR.ok) {
  const j = JSON.parse(iamT) as { bindings?: Array<{ role: string; members?: string[] }> };
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const saEmail = (JSON.parse(keyRaw) as { client_email: string }).client_email;
  const saId = `serviceAccount:${saEmail}`;
  for (const b of j.bindings ?? []) {
    if (b.members?.includes(saId)) {
      console.log(`  ✅ Role: ${b.role}`);
    }
  }
} else {
  console.log(`Error: ${iamT.slice(0, 200)}`);
}

// Try Vertex AI with generateContent — check if API enabled
const vtxCheckR = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models`,
  { headers: { Authorization: `Bearer ${vtxToken}` } },
);
const vtxCheckT = await vtxCheckR.text();
console.log(`Vertex AI list models: ${vtxCheckR.status} — ${vtxCheckT.slice(0, 200)}`);

// ── 3. Try direct RAG search and display answer snippet ───────────────────────
console.log('\n═══ 3. Knowledge base proof — direct search snippets ═══');
const questions = [
  'What is the sick leave policy?',
  'How many days of earned leave do employees get?',
  'What are the Python coding standards?',
  'How do engineers deploy code?',
];

for (const q of questions) {
  const srchR = await fetch(`${collBase}/dataStores/cf-knowledge-eng-hr/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, pageSize: 1, contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 1 } } }),
  });
  const srchJ = await srchR.json() as { results?: Array<{ document?: { derivedStructData?: Record<string, unknown> } }> };
  const r = srchJ.results?.[0]?.document?.derivedStructData ?? {};
  const title = r['title'] as string ?? '(no match)';
  const snips = r['snippets'] as Array<{ snippet?: string; snippet_status?: string }> ?? [];
  const snip = snips.filter(s => s.snippet_status === 'SUCCESS').map(s => s.snippet?.replace(/<[^>]+>/g, '') ?? '').join(' ');
  console.log(`\n  Q: "${q}"`);
  if (snip) {
    console.log(`  📄 Source: ${title}`);
    console.log(`  Excerpt: ${snip.slice(0, 200)}`);
  } else {
    console.log(`  (no results)`);
  }
}

// ── 4. Try Vertex AI Gemini via chat completions format ───────────────────────
console.log('\n═══ 4. Vertex AI — try global endpoint + different path ═══');
const globalR = await fetch(
  `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/gemini-2.0-flash:generateContent`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${vtxToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say OK.' }] }] }),
  }
);
const globalT = await globalR.text();
console.log(`Global endpoint: ${globalR.status} — ${globalT.slice(0, 150)}`);
