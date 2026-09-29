/**
 * The preflight log claimed "projectWide: granted" for the Reasoning Engine service
 * agent's Secret Manager access. Verify that claim directly against the real project IAM
 * policy right now, rather than trust the log line — this is the one identity difference
 * between my own successful manual tests (using our main SA) and what the deployed
 * container itself uses at runtime.
 *
 * Run: npx tsx src/spikes/_diag_verify_re_service_agent_grant.ts
 */
const { getSaToken } = await import('../auth/google.js');
const { hasProjectWideSecretAccess, reasoningEngineServiceAgent } = await import('../services/connectorPreflight.js');

const PROJECT = 'agentmigrations';
const PROJECT_NUMBER = '505103737920';

async function main() {
  const saToken = await getSaToken();
  const member = `serviceAccount:${reasoningEngineServiceAgent(PROJECT_NUMBER)}`;
  console.log('Checking member:', member);
  const state = await hasProjectWideSecretAccess(saToken, PROJECT, member);
  console.log('project-wide secretAccessor state:', state);

  // Also print the FULL raw IAM policy bindings relevant to secretAccessor, to see every
  // member that has it — in case the grant is under a slightly different account name.
  const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const policy = (await res.json()) as { bindings?: Array<{ role: string; members?: string[] }> };
  const relevant = (policy.bindings ?? []).filter((b) => b.role.includes('secretmanager'));
  console.log('\nAll secretmanager-related IAM bindings on this project:');
  console.log(JSON.stringify(relevant, null, 2));
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
