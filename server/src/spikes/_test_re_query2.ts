/**
 * Test RE query - regular JSON (no SSE).
 * Usage: cd server && npx tsx src/spikes/_test_re_query2.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const RE_PATH = 'projects/231705905417/locations/us-central1/reasoningEngines/6740183849394765824';
const tok = await getSaToken();

console.log('Querying RE (regular JSON)...');
const r = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'stream_query',
      input: { user_id: 'test', message: 'what is the leave policy?' },
    }),
  },
);
const text = await r.text();
console.log(`Status: ${r.status}`);
try {
  const j = JSON.parse(text) as Record<string, unknown>;
  const content = j['content'] as Record<string, unknown> | undefined;
  const parts = content?.['parts'] as Array<Record<string, unknown>> | undefined;
  const answer = parts?.map(p => p['text']).join('') ?? '';
  console.log('Answer:', answer.slice(0, 1000) || '(empty)');
  const grounding = j['grounding_metadata'] as Record<string, unknown> | undefined;
  const queries = grounding?.['retrieval_queries'];
  const meta = grounding?.['retrieval_metadata'];
  console.log('Retrieval queries:', JSON.stringify(queries));
  console.log('Retrieval metadata:', JSON.stringify(meta));
  const groundingChunks = grounding?.['groundingChunks'] ?? grounding?.['grounding_chunks'];
  console.log('Grounding chunks:', JSON.stringify(groundingChunks));
} catch {
  console.log('Raw (not JSON):', text.slice(0, 2000));
}
