import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/823509470192599040';

async function ask(saToken: string, message: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'real-migration-verify', message } }),
  });
  console.log(`\n>>> ${message}`);
  console.log('status:', res.status);
  console.log(await res.text());
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'What is the "Slack to Teams Migration Guide" file about? Summarize its key points and say which source you used.');
  await ask(saToken, 'What is mentioned in the dailyqueries file about getting a conflict report?');
  await ask(saToken, 'What is the capital of France?');
}
main().catch((e) => console.error('FAILED:', e.message));
