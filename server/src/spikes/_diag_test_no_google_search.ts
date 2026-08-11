import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/7501855136373800960';

async function ask(saToken: string, message: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'no-google-search-test', message } }),
  });
  console.log(`\n>>> ${message}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  const saToken = await getSaToken();
  // Control: something only public web search/general knowledge could answer,
  // NOT in this agent's actual knowledge sources — proves googleSearch is
  // absent if it correctly refuses instead of answering.
  await ask(saToken, 'What is the current stock price of Microsoft?');
  await ask(saToken, 'Who won the most recent Super Bowl?');
  // Real: something that should ONLY be answerable from its actual migrated
  // knowledge source (HR leave policy document).
  await ask(saToken, 'According to our HR leave policy, how many vacation days do employees get? Name your source.');
}
main().catch((e) => console.error('FAILED:', e.message));
