/**
 * Test RE query after IAM propagation.
 * Usage: cd server && npx tsx src/spikes/_test_re_query.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const RE_PATH = 'projects/231705905417/locations/us-central1/reasoningEngines/6740183849394765824';
const tok = await getSaToken();

// Wait for IAM propagation
console.log('Waiting 90s for IAM propagation...');
await new Promise(r => setTimeout(r, 90000));

console.log('Querying RE...');
const r = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery?alt=sse`,
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
console.log(text.slice(0, 3000));
