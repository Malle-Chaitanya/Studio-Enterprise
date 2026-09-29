/**
 * Project-level IAM read failed with 403 for our own SA — but that's a different
 * permission (resourcemanager.projects.getIamPolicy) than what actually matters: can the
 * Reasoning Engine service agent read THIS SPECIFIC secret? Check the per-secret IAM
 * policy directly (secretmanager.secrets.getIamPolicy), which is what really determines
 * whether the deployed agent can read its own credentials.
 *
 * Run: npx tsx src/spikes/_diag_check_per_secret_grant.ts
 */
const { getSaToken } = await import('../auth/google.js');
const { reasoningEngineServiceAgent } = await import('../services/connectorPreflight.js');

const PROJECT = 'agentmigrations';
const PROJECT_NUMBER = '505103737920';
const HOST = 'https://secretmanager.googleapis.com/v1';

async function main() {
  const saToken = await getSaToken();
  const member = `serviceAccount:${reasoningEngineServiceAgent(PROJECT_NUMBER)}`;
  const secretIds = [
    'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-tenant-id',
    'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-id',
    'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-secret',
  ];
  for (const secretId of secretIds) {
    const res = await fetch(`${HOST}/projects/${PROJECT}/secrets/${secretId}:getIamPolicy`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (!res.ok) {
      console.log(secretId, '-> getIamPolicy FAILED', res.status, (await res.text()).slice(0, 200));
      continue;
    }
    const policy = (await res.json()) as { bindings?: Array<{ role: string; members?: string[] }> };
    const granted = (policy.bindings ?? []).some(
      (b) => b.role === 'roles/secretmanager.secretAccessor' && (b.members ?? []).includes(member),
    );
    console.log(secretId, '-> RE agent granted at PER-SECRET level:', granted);
    console.log('   full bindings:', JSON.stringify(policy.bindings));
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
