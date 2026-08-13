/**
 * Ask a just-migrated agent a question, through the same client the verifier uses.
 *
 * Both migration runs ended with `verified: -` and `read ECONNRESET`. That is a failure of
 * the VERIFY call, which is not the same thing as a failed agent — and the difference is
 * exactly what "does it work" turns on. Ask it directly.
 *
 *   npx tsx src/spikes/_ask_migrated.ts <reasoningEngineId> "question"
 */
import 'dotenv/config';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';
import { getSaToken } from '../auth/google.js';

const ENGINE = process.argv[2];
const Q = process.argv[3] ?? 'What can you do? List your tools.';
const RE = `projects/231705905417/locations/us-central1/reasoningEngines/${ENGINE}`;
const token = await getSaToken();
console.log(`asking ${ENGINE}: ${Q}\n`);
try {
  const answer = await chatWithAdkAgent(RE, token, Q);
  console.log(`ANSWER: ${JSON.stringify(answer).slice(0, 1200)}`);
} catch (e) {
  console.log(`FAILED: ${(e as Error).message.slice(0, 400)}`);
}
process.exit(0);
