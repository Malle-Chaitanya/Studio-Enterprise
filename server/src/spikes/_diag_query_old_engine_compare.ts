// Compare against a PRE-EXISTING reasoning engine (from before today's fix)
// with the same question, to tell apart "my new deploy is broken" from
// "this is a pre-existing model/data quirk with this data store".
//   npx tsx src/spikes/_diag_query_old_engine_compare.ts
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/823509470192599040';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'async_stream_query',
      input: { user_id: 'compare-old-engine', message: 'What is mentioned in the dailyqueries file about getting a conflict report?' },
    }),
  });
  const text = await res.text();
  writeFileSync('raw_old_engine.txt', `STATUS: ${res.status}\nLENGTH: ${text.length}\n\n${text}`, 'utf-8');
  console.log(`wrote raw_old_engine.txt (status ${res.status}, ${text.length} bytes)`);
}
main().catch((e) => console.error('FAILED:', e.message));
