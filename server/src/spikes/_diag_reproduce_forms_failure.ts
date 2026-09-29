/**
 * Reproduce the Microsoft Forms tool's real failure directly — mint a token with the
 * exact scope the registry specifies (https://forms.office.com/.default) using the same
 * real stored credentials, then call the real Forms API endpoint captured earlier
 * (db/repos/connectorRegistry.ts: '/formapi/api/forms') to see Microsoft's real response.
 *
 * Run: npx tsx src/spikes/_diag_reproduce_forms_failure.ts
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

async function main() {
  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  console.log('Minting a token with scope https://forms.office.com/.default ...');
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://forms.office.com/.default',
  });
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    console.log('TOKEN MINT FAILED:', tokenRes.status);
    console.log('error:', (tokenBody as any).error);
    console.log('error_description:', ((tokenBody as any).error_description ?? '').split('\r\n')[0]);
    return;
  }
  console.log('token minted OK. Calling the real Forms API now...\n');
  const accessToken = (tokenBody as any).access_token as string;

  for (const path of ['formapi/api/forms', "formapi/api/forms('S28A16UF90Kuedbwg8h9vWUACvZQ')"]) {
    const res = await fetch(`https://forms.office.com/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await res.text();
    console.log(`=== GET https://forms.office.com/${path} ===`);
    console.log('status:', res.status);
    console.log('body:', body.slice(0, 500));
    console.log('');
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
