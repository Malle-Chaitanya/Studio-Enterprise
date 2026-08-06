import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJ_NUM = '231705905417';
const RE_ID = '6618586659455762432';
const RE_PATH = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;
const tok = await getSaToken();

// Check classMethods
console.log('=== RE classMethods ===');
const meta = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}`, { headers: { Authorization: `Bearer ${tok}` } });
const mj = await meta.json() as Record<string, unknown>;
console.log('classMethods:', JSON.stringify(mj['classMethods']));

// Test with default query method (what Agentspace sends — no class_method specified)
console.log('\n=== Test: no class_method (Agentspace default) ===');
const r1 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: { message: 'what is the leave policy?' } }),
});
const t1 = await r1.text();
console.log(`Status: ${r1.status}: ${t1.slice(0, 400)}`);

// Test with explicit query method
console.log('\n=== Test: class_method=query ===');
const r2 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'query', input: { message: 'what is the leave policy?' } }),
});
const t2 = await r2.text();
console.log(`Status: ${r2.status}: ${t2.slice(0, 400)}`);
