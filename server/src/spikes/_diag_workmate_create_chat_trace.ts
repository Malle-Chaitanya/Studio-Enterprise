/**
 * Reproduce the customer's exact request against the LIVE deployed WorkMate agent and
 * capture the raw tool-call trace (function_call args, function_response/error) — rather
 * than guessing what `_user()` or the parsed member_emails resolved to.
 *
 *   cd server && npx tsx src/spikes/_diag_workmate_create_chat_trace.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const REASONING_ENGINE_ID = '6666740870705840128';

const token = await getSaToken('zara@storefuze.com');

const res = await fetch(
  `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${REASONING_ENGINE_ID}:streamQuery?alt=sse`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'stream_query',
      input: { user_id: 'cf-diag', message: 'create a chat with the alex@filefuze.co ,ben@filefuze.co in teams' },
    }),
  },
);
console.log(`status: ${res.status}`);
const text = await res.text();
console.log(text.slice(0, 6000));
