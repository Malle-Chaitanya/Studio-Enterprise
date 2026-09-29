/**
 * The deployed "Sales Profiler Agent" fails EVERY ms_graph-backed tool call with a vague
 * "encountered an authentication error" — that's the model's own paraphrase of whatever
 * our tool's {"error": "..."} dict actually said, and we can't see the real text from the
 * chat UI. Reproduce the EXACT same client_credentials token mint the deployed container
 * does, using the real stored ms_graph secrets in the destination project, to get Azure
 * AD's own real error code — without ever printing the secret values themselves.
 *
 * Run: npx tsx src/spikes/_diag_reproduce_ms_graph_auth_failure.ts
 */
const { getSaToken } = await import('../auth/google.js');

const PROJECT = 'agentmigrations';
const SCOPE_PREFIX = 'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph';
const HOST = 'https://secretmanager.googleapis.com/v1';

async function readSecret(saToken: string, secretId: string): Promise<string | null> {
  const url = `${HOST}/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!res.ok) {
    console.log(`  readSecret(${secretId}): FAILED ${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as { payload?: { data?: string } };
  if (!json.payload?.data) return null;
  return Buffer.from(json.payload.data, 'base64').toString('utf-8');
}

async function main() {
  const saToken = await getSaToken();

  console.log('Reading ms_graph credential group secrets from', PROJECT, '...');
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  console.log('tenant_id present:', Boolean(tenantId), tenantId ? `(len ${tenantId.length})` : '');
  console.log('client_id present:', Boolean(clientId), clientId ? `(len ${clientId.length})` : '');
  console.log('client_secret present:', Boolean(clientSecret), clientSecret ? `(len ${clientSecret.length})` : '');

  if (!tenantId || !clientId || !clientSecret) {
    console.log('\nOne or more ms_graph secrets are missing in the destination project — that alone would cause every Graph tool call to fail auth.');
    return;
  }

  console.log('\nAttempting the SAME client_credentials token mint the deployed container performs...');
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await tokenRes.json().catch(() => ({}));
  if (tokenRes.ok) {
    console.log('SUCCESS — token minted. access_token length:', (body as any).access_token?.length);
    console.log('expires_in:', (body as any).expires_in);
  } else {
    console.log(`FAILED (${tokenRes.status}) — Azure AD's real error:`);
    console.log('  error:', (body as any).error);
    console.log('  error_description:', ((body as any).error_description ?? '').split('\r\n')[0]);
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
