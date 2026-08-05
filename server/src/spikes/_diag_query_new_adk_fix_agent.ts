// Directly queries the Reasoning Engine deployed by
// _diag_verify_adk_knowledge_parity_fix.ts, using the SAME streamQuery
// mechanism this repo has already live-verified against ADK agents (see
// _diag_query_kb_test_agent_real.ts) — the Discovery Engine ":assist" REST
// endpoint verify.ts uses returned 400 for this agent, so this is the real check.
//   npx tsx src/spikes/_diag_query_new_adk_fix_agent.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/8898111758347010048';

async function ask(saToken: string, message: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'fix-verify-2026-08-04', message } }),
  });
  console.log(`\n>>> ${message}`);
  console.log('status:', res.status);
  console.log(await res.text());
}

async function main() {
  const saToken = await getSaToken();
  await ask(saToken, 'What is mentioned in the daily_queries file about getting a Conflict report for a onetime migration? Quote the actual query if you can find it.');
  await ask(saToken, 'Which knowledge source did you use to answer the previous question?');
  await ask(saToken, 'What is the capital of France?'); // control question — should NOT need the knowledge source
}
main().catch((e) => console.error('FAILED:', e.message));
