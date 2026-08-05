// Same as _diag_query_new_adk_fix_agent.ts but writes the exact raw response
// bytes to a file (no console truncation/collapsing) so every SSE frame is
// visible, and retries the ask once after a short delay in case the first
// turn is just the tool-invocation event with the real answer in a later frame.
//   npx tsx src/spikes/_diag_query_new_adk_fix_agent_raw.ts
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/8898111758347010048';

async function ask(saToken: string, message: string, outFile: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'fix-verify-raw', message } }),
  });
  const text = await res.text();
  writeFileSync(outFile, `STATUS: ${res.status}\nLENGTH: ${text.length}\n\n${text}`, 'utf-8');
  console.log(`wrote ${outFile} (status ${res.status}, ${text.length} bytes)`);
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'What is mentioned in the daily_queries file about getting a Conflict report for a onetime migration? Quote the actual query if you can find it.', 'raw1.txt');
  await new Promise((r) => setTimeout(r, 3000));
  await ask(saToken, 'Search your knowledge source for "Conflict report" and tell me exactly what you find, word for word.', 'raw2.txt');
}
main().catch((e) => console.error('FAILED:', e.message));
