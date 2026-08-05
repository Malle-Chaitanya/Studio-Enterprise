import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/7337403381230600192';
async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'verify-v2', message: 'What is the Slack to Teams Migration Guide about? Search your knowledge source.' } }),
  });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
