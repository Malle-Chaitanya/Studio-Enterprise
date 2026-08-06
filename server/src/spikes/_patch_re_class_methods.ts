/**
 * Try patching the v8 RE metadata to add classMethods=['query','stream_query'].
 * Hypothesis: RE runtime may read classMethods from metadata to build allowlist.
 * If the runtime trusts the metadata over its own discovery, adding 'query'
 * here would make class_method='query' work.
 *
 * Run: cd server && npx tsx src/spikes/_patch_re_class_methods.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT_NUM = '231705905417';
const V8_RE_ID = '8175706230619111424';
const RE_PATH = `projects/${SA_PROJECT_NUM}/locations/us-central1/reasoningEngines/${V8_RE_ID}`;
const HOST = 'https://us-central1-aiplatform.googleapis.com/v1beta1';

const token = await getSaToken();

// ── Step 1: Get current RE metadata ──────────────────────────────────────────
console.log('[1] Current RE metadata...');
const mr = await fetch(`${HOST}/${RE_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
const mj = await mr.json() as Record<string, unknown>;
console.log(`  classMethods: ${JSON.stringify(mj['classMethods'])}`);
console.log(`  state: ${mj['state']}`);

// ── Step 2: Patch classMethods ────────────────────────────────────────────────
console.log('\n[2] Patching classMethods to include query...');
const patchBody = {
  classMethods: ['query', 'stream_query', 'async_stream_query', 'streaming_agent_run_with_events'],
};
const pr = await fetch(`${HOST}/${RE_PATH}?updateMask=classMethods`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(patchBody),
});
const pt = await pr.text();
console.log(`  PATCH status: ${pr.status}`);
if (!pr.ok) {
  console.log(`  Error: ${pt.slice(0, 400)}`);
  // Try without updateMask
  console.log('\n  Trying without updateMask...');
  const pr2 = await fetch(`${HOST}/${RE_PATH}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  });
  const pt2 = await pr2.text();
  console.log(`  PATCH (no mask) status: ${pr2.status}`);
  console.log(`  ${pt2.slice(0, 400)}`);
} else {
  const pj = JSON.parse(pt) as Record<string, unknown>;
  console.log(`  New classMethods: ${JSON.stringify(pj['classMethods'])}`);
}

// ── Step 3: Verify updated metadata ──────────────────────────────────────────
console.log('\n[3] Verifying updated metadata...');
await new Promise(r => setTimeout(r, 3000));
const mr2 = await fetch(`${HOST}/${RE_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
const mj2 = await mr2.json() as Record<string, unknown>;
console.log(`  classMethods after patch: ${JSON.stringify(mj2['classMethods'])}`);

// ── Step 4: Test class_method=query ──────────────────────────────────────────
if (mj2['classMethods']) {
  console.log('\n[4] Testing class_method=query after patch...');
  const qr = await fetch(`${HOST}/${RE_PATH}:streamQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'query',
      input: { user_id: 'patch-test', message: 'What is the sick leave policy?' },
    }),
  });
  const qt = await qr.text();
  console.log(`  query status: ${qr.status}`);
  if (qr.ok) {
    const lines = qt.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        const parts = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>) ?? [];
        const text = parts.map(p => p['text']).join('');
        if (text) { console.log(`  ✅ Answer: ${text.slice(0, 300)}`); break; }
      } catch { /* skip */ }
    }
  } else {
    console.log(`  Error: ${qt.slice(0, 400)}`);
  }
}
