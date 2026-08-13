import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/527529736088322048';
const PROBE = "List the files in the Google Drive folder with ID 1TErpf1LTEed-SMa1y9HhwBgsb2O-6Kwy";

async function main() {
  const saToken = await getSaToken();
  const url = `https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'async_stream_query',
      input: { user_id: 'diag-test-user', message: PROBE },
    }),
  });
  console.log('status:', res.status);
  const text = await res.text();
  console.log(text.slice(0, 8000));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
