import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-west1/reasoningEngines/7415009660698099712';

async function ask(saToken: string, message: string) {
  const res = await fetch(`https://us-west1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'diag-check', message } }),
  });
  console.log(`\n>>> ${message}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'What MongoDB query do I use to get the Conflict report for a onetime migration?');
}
main().catch((e) => console.error('FAILED:', e.message));
