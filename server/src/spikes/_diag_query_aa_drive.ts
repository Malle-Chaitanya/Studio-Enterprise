/** Functional test: does "AA"'s newly-deployed live Google Drive tool actually fetch
 *  real data, or does it just describe itself without calling anything? Queries the
 *  ACTUAL Reasoning Engine recorded for this deployment (see adkDeployments), which
 *  landed in project 231705905417 due to a stale per-environment destination mapping
 *  on the session (session.plan.destination.environmentMap), not project 72860638029.
 *  npx tsx src/spikes/_diag_query_aa_drive.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/5445319791688548352';
const PROBE = 'Use your Google Drive tool to list the files in the root of my Google Drive. Tell me exactly what the tool returned, including any error.';

async function main() {
  const saToken = await getSaToken();
  const url = `https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'async_stream_query',
      input: { user_id: 'diag-drive-fetch-test', message: PROBE },
    }),
  });
  console.log('status:', res.status);
  const text = await res.text();
  console.log(text.slice(0, 12000));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
