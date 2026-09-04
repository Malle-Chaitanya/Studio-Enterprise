/**
 * Bypass Discovery Engine's agent wrapper entirely and query the Reasoning Engine
 * REST resource directly, to determine whether the "wrong_agent_tools" verification
 * failure on WorkMate (2026-08-25) is a DEPLOY-time bug (the container itself was built
 * from the wrong package) or a REGISTRATION-time bug (the container is fine, but the
 * Discovery Engine agent record points at the wrong reasoningEngine id).
 *
 * Read-only (a query, not a mutation).
 *
 *   cd server && npx tsx src/spikes/_diag_reasoning_engine_direct_query.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/6666740870705840128';
const LOCATION = 'us-central1';

const token = await getSaToken('zara@storefuze.com');

// Confirm the resource's own metadata first — spec/displayName, if exposed.
const getRes = await fetch(`https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${REASONING_ENGINE}`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log(`GET reasoningEngine: ${getRes.status}`);
console.log((await getRes.text()).slice(0, 2000));

console.log('\n--- direct :query ---');
const queryRes = await fetch(`https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${REASONING_ENGINE}:query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'query',
    input: { input: 'What tools do you have access to? List every tool name.' },
  }),
});
const queryText = await queryRes.text();
console.log(`POST :query -> ${queryRes.status}`);
console.log(queryText.slice(0, 3000));
