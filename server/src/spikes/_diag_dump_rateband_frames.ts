/** Dump raw SSE frames from the test-clone agent to verify the actual tool-call/response
 *  structure, not just trust the prose answer. npx tsx src/spikes/_diag_dump_rateband_frames.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const RE = 'projects/505103737920/locations/us-central1/reasoningEngines/969916040500740096';
const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE}:streamQuery?alt=sse`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'rateband-attach-test-2', message: 'What rate applies for limit 500000?' } }),
});
const raw = await res.text();
console.log('status:', res.status);
console.log(raw.slice(0, 3000));
process.exit(0);
