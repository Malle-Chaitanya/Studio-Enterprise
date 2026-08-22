/**
 * Ask a DEPLOYED agent a real question and read the tool evidence structurally.
 *
 * Prose is not proof — the model can describe an inbox it never opened. Evidence is a
 * `function_call` frame naming a tool plus a non-error `function_response`, which is what
 * scanToolEvidence reads. Used here to settle whether a migration that reports
 * verified=true actually has working tools.
 *
 *   cd server && npx tsx src/spikes/_diag_ask_deployed.ts <engineId> "<question>"
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';

const ENGINE = process.argv[2];
const Q = process.argv[3] || 'What Teams am I a member of? Use your tools.';
if (!ENGINE) { console.log('usage: _diag_ask_deployed.ts <engineId> "<question>"'); process.exit(1); }

const saToken = await getSaToken();
const r = await chatWithAdkAgent('231705905417', saToken, {
  reasoningEngineId: ENGINE,
  message: Q,
  userId: 'cf-diag',
  location: 'us-central1',
});

console.log(`ok=${r.ok}`);
console.log(`\nQ: ${Q}`);
console.log(`A: ${(r.answer ?? '(no answer)').slice(0, 1200)}`);

// chatWithAdkAgent already scans the stream and returns the evidence — re-scanning a
// stringified wrapper (as this spike first did) finds nothing and reports a working tool as
// prose-only, which is a false negative in the one place that must not have them.
console.log(`
--- TOOL EVIDENCE ---`);
console.log(`called   : ${r.toolCalled ? r.toolNames?.join(', ') || '(called, name not parsed)' : '(NO function_call frame - prose only, NOT proof)'}`);
console.log(`succeeded: ${r.toolSucceeded}`);
if (r.toolError) console.log(`error    : ${r.toolError}`);
process.exit(0);
