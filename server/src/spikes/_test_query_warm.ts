/**
 * Test class_method='query' on warm v8 RE.
 * Run: cd server && npx tsx src/spikes/_test_query_warm.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT_NUM = '231705905417';
const V8_RE_ID = '8175706230619111424';
const RE_PATH = `projects/${SA_PROJECT_NUM}/locations/us-central1/reasoningEngines/${V8_RE_ID}`;
const HOST = 'https://us-central1-aiplatform.googleapis.com/v1beta1';

const token = await getSaToken();
console.log('Testing class_method=query on WARM v8 RE...');

const r = await fetch(`${HOST}/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'query',
    input: { user_id: 'test-query-warm', message: 'What is the sick leave policy?' },
  }),
});
const t = await r.text();
console.log(`query status: ${r.status}`);
console.log(t.slice(0, 800));
