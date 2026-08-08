import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const AGENTS = [
  { name: 'Employee Onboarding Helper', re: 'projects/231705905417/locations/us-central1/reasoningEngines/4971958045698424832', q: 'According to the Neutara HR Leave Policies document, how many vacation days do employees get? Name your source.' },
  { name: 'CloudFuze Studio Migrate', re: 'projects/231705905417/locations/us-central1/reasoningEngines/9160305699152986112', q: 'According to the Migrate Agent PRD document, what is this agent migration tool supposed to do? Name your source.' },
];

async function ask(saToken: string, reasoningEngine: string, message: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${reasoningEngine}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'final-real-test', message } }),
  });
  return await res.text();
}

async function main() {
  const saToken = await getSaToken();
  for (const a of AGENTS) {
    console.log(`\n=== ${a.name} ===`);
    const text = await ask(saToken, a.re, a.q);
    console.log(text.slice(0, 2500));
  }
}
main().catch((e) => console.error('FAILED:', e.message));
