// Verifies the newly-deployed multi-knowledge-source agent actually retrieves
// from BOTH sources (SharePoint connector + uploaded PDF), not just that the
// deploy succeeded.
//   npx tsx src/spikes/_diag_verify_multistore_deploy.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/4888500715103715328';

async function ask(saToken: string, message: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'verify-multistore', message } }),
  });
  console.log(`\n>>> ${message}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'What MongoDB query do I use to get the Conflict report for a onetime migration? Quote it exactly and name your source.');
  await ask(saToken, 'What is the "Slack to Teams Migration Guide" about? Summarize its key points and name your source.');
  await ask(saToken, 'What is the capital of France?');
}
main().catch((e) => console.error('FAILED:', e.message));
