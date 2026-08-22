/** Closes PERMISSION-MAPPING-ARCHITECTURE.md open question #2: do
 *  roles/discoveryengine.agentspaceViewer, .agentViewer, or .agentEditor exist as
 *  valid per-agent (or engine-level, for agentspaceViewer) IAM policy values, or does
 *  only roles/discoveryengine.agentUser exist at the agent grain as grantAgentAccess()
 *  (services/gemini.ts:215-262) already assumes? No prior WebFetch this session could
 *  confirm or deny these from Google's own docs (pages repeatedly returned only
 *  navigation content) — this settles it the same way grantAgentAccess() itself was
 *  originally settled: a real setIamPolicy call, reading the literal API error.
 *  No mongo. Token via SA key + GOOGLE_IMPERSONATE_EMAIL.
 *   npx tsx src/spikes/_diag_probe_agent_roles.ts <project> <engineId> <agentId> [testEmail] */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE, AGENT, TEST_EMAIL_ARG] = process.argv.slice(2);
const AGENT_BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;
const ENGINE_BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}`;

// Every claimed-but-unconfirmed role, plus the one already known-good (agentUser) as a
// control — if agentUser succeeds and the rest 400 with "invalid role" (not a generic
// auth/network failure), that's a clean confirm/deny.
const CANDIDATE_ROLES = [
  'roles/discoveryengine.agentUser', // control — known to work (grantAgentAccess)
  'roles/discoveryengine.agentViewer',
  'roles/discoveryengine.agentEditor',
] as const;

async function probeAgentLevel(token: string, testEmail: string) {
  console.log(`\n=== Per-agent IAM policy: ${AGENT_BASE.split('/agents/')[1]} ===`);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const getRes = await fetch(`${AGENT_BASE}:getIamPolicy`, { method: 'GET', headers: h });
  const existing = getRes.ok ? ((await getRes.json()) as { bindings?: unknown[]; etag?: string }) : {};
  console.log(`:getIamPolicy -> ${getRes.status} (etag ${existing.etag ?? 'none'})`);

  for (const role of CANDIDATE_ROLES) {
    const body = JSON.stringify({
      policy: { bindings: [{ role, members: [`user:${testEmail}`] }], etag: existing.etag },
    });
    const setRes = await fetch(`${AGENT_BASE}:setIamPolicy`, { method: 'POST', headers: h, body });
    const text = (await setRes.text()).replace(/\s+/g, ' ').slice(0, 220);
    console.log(`  ${role.padEnd(38)} -> ${setRes.status}  ${text}`);
  }
}

async function probeEngineLevel(token: string, testEmail: string) {
  console.log(`\n=== Engine-level IAM policy: ${ENGINE} ===`);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const getRes = await fetch(`${ENGINE_BASE}:getIamPolicy`, { method: 'GET', headers: h });
  const existing = getRes.ok ? ((await getRes.json()) as { bindings?: unknown[]; etag?: string }) : {};
  console.log(`:getIamPolicy -> ${getRes.status} (etag ${existing.etag ?? 'none'})`);

  // agentspaceViewer is the other unconfirmed claim — tested at engine level since
  // that's the grain agentspaceUser/agentspaceRestrictedUser actually operate at
  // (see PERMISSION-MAPPING-ARCHITECTURE.md B.1); it was never claimed to be per-agent.
  const body = JSON.stringify({
    policy: {
      bindings: [{ role: 'roles/discoveryengine.agentspaceViewer', members: [`user:${testEmail}`] }],
      etag: existing.etag,
    },
  });
  const setRes = await fetch(`${ENGINE_BASE}:setIamPolicy`, { method: 'POST', headers: h, body });
  const text = (await setRes.text()).replace(/\s+/g, ' ').slice(0, 220);
  console.log(`  roles/discoveryengine.agentspaceViewer      -> ${setRes.status}  ${text}`);
}

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) {
    throw new Error('usage: _diag_probe_agent_roles.ts <project> <engineId> <agentId> [testEmail]');
  }
  const testEmail = TEST_EMAIL_ARG || process.env.GOOGLE_IMPERSONATE_EMAIL || 'zara@storefuze.com';
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);

  await probeAgentLevel(token, testEmail);
  await probeEngineLevel(token, testEmail);

  console.log(
    '\nRead the CANDIDATE_ROLES results above: a 400 naming the role as an invalid/unrecognized ' +
      'enum value confirms the role does not exist at that grain. A 200 (even if the grant has no ' +
      'visible effect) means the API accepted the string and this needs a follow-up live-login test, ' +
      'not just this probe, before drawing a conclusion either way.',
  );
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});