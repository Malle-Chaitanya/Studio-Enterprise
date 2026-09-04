/** What kind of agent is the real, live Deal Desk (low-code vs ADK), and what tools
 *  does it currently have? Read-only.
 *  npx tsx src/spikes/_diag_dealdesk_gemini_detail.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

const saToken = await getSaToken();
const dest = await resolveDestination('agentmigrations', saToken);
const agentId = '799212249850277623';
const res = await fetch(`${assistantBase(dest)}/agents/${agentId}`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const json = await res.json();
console.log(JSON.stringify(json, null, 2).slice(0, 4000));
process.exit(0);
