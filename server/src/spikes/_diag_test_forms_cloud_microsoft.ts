/**
 * Retest Microsoft Forms against the CORRECT, newer domain (forms.cloud.microsoft, matching
 * the real form URL the user shared) instead of the legacy forms.office.com I tested
 * before — real docs indicate app-only access (Forms.Read.All) may work against this domain
 * for individually-owned forms, which is what our real test form is.
 *
 * Run: npx tsx src/spikes/_diag_test_forms_cloud_microsoft.ts
 */
const { getSaToken } = await import('../auth/google.js');

const PROJECT = 'agentmigrations';
const SCOPE_PREFIX = 'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph';
const HOST = 'https://secretmanager.googleapis.com/v1';
const REAL_FORM_ID = 'cmd9gHyE4kCb7OLJMLOkLnilnoyUtOdClmkgPBy1CY5UMkZBNllIRlY3WjZEQlBGOUJDMEpES1JDTS4u';

async function readSecret(saToken: string, secretId: string): Promise<string> {
  const url = `${HOST}/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

async function mintToken(tenantId: string, clientId: string, clientSecret: string, scope: string) {
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  console.log('Minting a token with scope https://forms.cloud.microsoft/.default ...');
  const t = await mintToken(tenantId, clientId, clientSecret, 'https://forms.cloud.microsoft/.default');
  if (!t.ok) {
    console.log('TOKEN MINT FAILED:', t.status, JSON.stringify(t.body).slice(0, 500));
    return;
  }
  console.log('token minted OK. Calling forms.cloud.microsoft with it...\n');
  const accessToken = (t.body as any).access_token as string;

  for (const url of [
    'https://forms.cloud.microsoft/formapi/api/forms',
    `https://forms.cloud.microsoft/formapi/api/forms('${REAL_FORM_ID}')`,
  ]) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    console.log(`=== GET ${url} ===`);
    console.log('status:', res.status);
    console.log('body:', (await res.text()).slice(0, 500));
    console.log('');
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
