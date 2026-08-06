/**
 * Test class_method='query' via v1 (GA) endpoint.
 * Run: cd server && npx tsx src/spikes/_test_v1_query.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const RE_PATH = 'projects/231705905417/locations/us-central1/reasoningEngines/8175706230619111424';
const token = await getSaToken();

for (const [version, method] of [['v1beta1', 'query'], ['v1beta1', 'stream_query'], ['v1', 'query'], ['v1', 'stream_query']]) {
  const url = `https://us-central1-aiplatform.googleapis.com/${version}/${RE_PATH}:streamQuery`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: method, input: { user_id: 'v1-test', message: 'sick leave policy?' } }),
  });
  const t = await r.text();
  const ok = r.status === 200;
  const snippet = ok ? t.slice(0, 150) : t.slice(0, 150);
  console.log(`[${version}] class_method=${method} → ${r.status} ${ok ? '✅' : '❌'}`);
  console.log(`  ${snippet}\n`);
}
