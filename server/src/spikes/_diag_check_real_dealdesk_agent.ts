/** What does the REAL Deal Desk agent's own registration actually look like right now —
 *  which Reasoning Engine is it pointed at, and what tools does it really have? Read-only.
 *  npx tsx src/spikes/_diag_check_real_dealdesk_agent.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

const saToken = await getSaToken();
const dest = await resolveDestination('agentmigrations', saToken);
const agentId = '18070527808868473392';
const res = await fetch(`${assistantBase(dest)}/agents/${agentId}`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
console.log('status:', res.status);
const json = await res.json();
console.log(JSON.stringify(json, null, 2).slice(0, 4000));
process.exit(0);
