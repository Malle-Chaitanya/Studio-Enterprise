/**
 * Execute a migrated flow's Application Integration DIRECTLY, bypassing the agent.
 * Separates "the flow works" from "the agent chose to call it" — the auth-config fix
 * (32dce26) is about the former only.
 *
 *   npx tsx src/spikes/_probe_flow_execute.ts
 *   FLOW=GenerateAmendmentDocument PARAMS='{"ClientName":"Atlas Industrial Group"}' npx tsx ...
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = process.env.FLOW_PROJECT || 'agentmigrations';
const LOCATION = 'us-east1';
const FLOW = process.env.FLOW || 'GetRateSheetBand';
const PARAMS = JSON.parse(process.env.PARAMS || '{"NewLimit":"5000000"}') as Record<string, string>;
const SUBJECT = process.env.SUBJECT || 'admin@migrationn.com';

const token = await getSaToken(SUBJECT);
const url = `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/${FLOW}:execute?triggerId=api_trigger/${FLOW}_API_1`;

// FLAT kwargs — the exact body adk_deploy.py's _invoke sends. The wrapped
// {inputParameters:{k:{doubleValue}}} form is silently IGNORED by :execute here: it returns
// 200 and runs the flow against each variable's declared default, so a numeric filter reads
// 0 and returns confidently wrong rows. Cost a live diagnosis; do not "fix" this back.
const body = PARAMS;

console.log(`POST ${FLOW}  params=${JSON.stringify(PARAMS)}  as=${SUBJECT}`);
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  const j = JSON.parse(text);
  console.log(JSON.stringify(j, null, 2).slice(0, 3000));
} catch {
  console.log(text.slice(0, 2000));
}
process.exit(0);
