/** Standalone proof: can an agent's own ambient service-account identity (the same
 *  kind of credential a deployed ADK Reasoning Engine would carry) call the published
 *  DraftFollowUpEmail Application Integration workflow directly, mirroring the exact
 *  request/response shape connector_tools/generic_rest.py's call_external_api uses?
 *  This does NOT deploy or touch any real ADK agent / Reasoning Engine -- read-only
 *  proof of the tool-function plumbing before committing to a real deployment.
 *  npx tsx src/spikes/_diag_draft_followup_tool_proof.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'DraftFollowUpEmail';
const TRIGGER_ID = 'api_trigger/DraftFollowUpEmail_API_1';

const URL =
  `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}` +
  `/integrations/${INTEGRATION}:execute?triggerId=${TRIGGER_ID}`;

/** The exact tool function shape a real ADK deployment would call. */
async function draftFollowUpEmail(args: {
  ClientName: string;
  NewLimit: string;
  NewRate: string;
  CovenantStatus: string;
}): Promise<{ status?: number; body?: unknown; error?: string }> {
  const saToken = await getSaToken();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) return { error: `draft_follow_up_email failed: ${text.slice(0, 500)}` };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text.slice(0, 4000) };
  }
}

const result = await draftFollowUpEmail({
  ClientName: 'Meridian Foods Inc.',
  NewLimit: '2500000',
  NewRate: '3.25%',
  CovenantStatus: 'unchanged',
});
console.log(JSON.stringify(result, null, 2));
process.exit(0);
