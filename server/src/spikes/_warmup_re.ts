/**
 * Warm up the v8 RE container by sending a stream_query request.
 * RE cold start takes ~5-8 minutes. Run this before testing in Agentspace.
 *
 * Run: cd server && npx tsx src/spikes/_warmup_re.ts
 * Then IMMEDIATELY go test "Confluence Knowledge Agent v8-reg" in business.gemini.google
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT_NUM = '231705905417';
const V8_RE_ID = '8175706230619111424';
const RE_PATH = `projects/${SA_PROJECT_NUM}/locations/us-central1/reasoningEngines/${V8_RE_ID}`;
const RE_HOST = 'https://us-central1-aiplatform.googleapis.com/v1beta1';

const token = await getSaToken();

console.log('Warming up v8 RE container...');
console.log('(First request after idle takes 5-8 minutes — this will wait)');
console.log('');

const start = Date.now();

// Retry loop — the first request ECONNRESET while container starts
let attempt = 0;
while (true) {
  attempt++;
  console.log(`Attempt ${attempt} (${Math.round((Date.now() - start) / 1000)}s elapsed)...`);

  try {
    const r = await fetch(`${RE_HOST}/${RE_PATH}:streamQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class_method: 'stream_query',
        input: { user_id: 'warmup', message: 'What is the sick leave policy?' },
      }),
    });

    const t = await r.text();
    console.log(`  Status: ${r.status}`);

    if (r.ok) {
      // Extract answer
      const lines = t.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const j = JSON.parse(line) as Record<string, unknown>;
          const parts = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>) ?? [];
          const text = parts.map(p => p['text']).join('');
          if (text) { console.log(`  Answer: ${text.slice(0, 200)}`); break; }
        } catch { /* skip */ }
      }
      if (!t.includes('"text"')) console.log(`  Raw: ${t.slice(0, 200)}`);

      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`\n✅ RE warmed up in ${elapsed}s!`);
      console.log('   Now go test in business.gemini.google IMMEDIATELY.');
      console.log('   Agent: "Confluence Knowledge Agent v8-reg"');
      console.log('   Ask: "What is the sick leave policy?"');
      console.log('   Container stays warm for ~15-30 minutes after last request.');
      break;
    }

    if (r.status === 400) {
      const j = JSON.parse(t) as { error?: { message: string } };
      if (j.error?.message.includes('not found')) {
        // method not found = container IS running, just query method blocked
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`  Container warm but query method not found. stream_query IS working.`);
        console.log(`  ✅ Container alive after ${elapsed}s`);
        break;
      }
    }

    console.log(`  Error: ${t.slice(0, 200)}`);
    if (attempt >= 15) {
      console.log('Max attempts reached. RE may be in an error state.');
      break;
    }
  } catch (e) {
    const err = e as Error;
    if (err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED')) {
      console.log(`  Container still starting... (${err.message})`);
    } else {
      console.log(`  Unexpected error: ${err.message}`);
    }
  }

  // Wait 30s between retries during cold start
  await new Promise(r => setTimeout(r, 30 * 1000));
}
