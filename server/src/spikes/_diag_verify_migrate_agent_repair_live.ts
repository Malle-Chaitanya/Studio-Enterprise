import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/4589152077371932672';

async function ask(saToken: string, message: string) {
  const res = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class_method: 'stream_query',
        input: { message, user_id: 'diag-verify' },
      }),
    },
  );
  const text = await res.text();
  console.log(`status: ${res.status}`);
  console.log(text.slice(0, 4000));
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'According to the Migrate Agent PRD document, what is this agent migration tool supposed to do? Name your source.');
  console.log('---');
  await ask(saToken, 'hey, what can you help me with?');
}
main().catch((e) => console.error('FAILED:', e.message));
