import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJ_NUM = '231705905417';
const RE_ID = '6618586659455762432';
const RE_PATH = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;
const tok = await getSaToken();

// Test 1: stream_query with correct ADK input (how AdkApp expects it)
console.log('=== Test 1: class_method=stream_query ===');
const r1 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const t1 = await r1.text();
console.log(`Status: ${r1.status}`);
try {
  const j = JSON.parse(t1) as Record<string, unknown>;
  const content = j['content'] as Record<string, unknown> | undefined;
  const text = (content?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
  console.log('Answer:', text.slice(0, 500) || JSON.stringify(j).slice(0, 400));
} catch { console.log('Raw:', t1.slice(0, 400)); }

// Test 2: no class_method (Agentspace default → stream_query)
console.log('\n=== Test 2: no class_method (Agentspace default) ===');
const r2 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const t2 = await r2.text();
console.log(`Status: ${r2.status}: ${t2.slice(0, 400)}`);

// Test 3: streaming_agent_run_with_events (what Agentspace might use)
console.log('\n=== Test 3: streaming_agent_run_with_events ===');
const r3 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'streaming_agent_run_with_events', input: { user_id: 'test', new_message: { role: 'user', parts: [{ text: 'what is the leave policy?' }] } } }),
});
const t3 = await r3.text();
console.log(`Status: ${r3.status}: ${t3.slice(0, 400)}`);
