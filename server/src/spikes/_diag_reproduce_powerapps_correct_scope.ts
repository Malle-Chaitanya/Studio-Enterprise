/**
 * Corrected test: mint a token with the SAME scope the registry actually specifies for
 * Power Apps for Makers (https://service.powerapps.com/.default — confirmed correct in
 * the built LiveConnectorSpec), then call the real Power Apps API with it, honestly.
 *
 * Run: npx tsx src/spikes/_diag_reproduce_powerapps_correct_scope.ts
 */
const { getSaToken } = await import('../auth/google.js');

const PROJECT = 'agentmigrations';
const SCOPE_PREFIX = 'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph';
const HOST = 'https://secretmanager.googleapis.com/v1';

async function readSecret(saToken: string, secretId: string): Promise<string> {
  const url = `${HOST}/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

async function mintToken(tenantId: string, clientId: string, clientSecret: string, scope: string) {
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  console.log('Minting a token with the CORRECT Power Apps scope (service.powerapps.com)...');
  const t = await mintToken(tenantId, clientId, clientSecret, 'https://service.powerapps.com/.default');
  if (!t.ok) {
    console.log('TOKEN MINT FAILED:', t.status, JSON.stringify(t.body).slice(0, 500));
    return;
  }
  const accessToken = (t.body as any).access_token as string;
  console.log('token minted OK. Now calling the real Power Apps "Get Apps" endpoint...\n');

  const res = await fetch('https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2016-11-01', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  console.log('status:', res.status);
  console.log('body:', (await res.text()).slice(0, 800));
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
