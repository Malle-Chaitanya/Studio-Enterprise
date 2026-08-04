import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/2047679328279330816';
const PROBE = 'How do I add SharePoint as a knowledge source?';

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
