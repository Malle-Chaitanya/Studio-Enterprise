/**
 * Test the REAL Work Request form ID directly against Microsoft Forms' API, to be fully
 * rigorous before confirming Forms is structurally broken for app-only auth — the earlier
 * test used a wrong/reused ID, this uses the real one from the user's own chat.
 *
 * Run: npx tsx src/spikes/_diag_test_real_form_id.ts
 */
const { getSaToken } = await import('../auth/google.js');

const PROJECT = 'agentmigrations';
const SCOPE_PREFIX = 'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph';
const HOST = 'https://secretmanager.googleapis.com/v1';
const FORM_ID = 'S28A16UF90Kuedbwg8h9vWUACvZQ';

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

  const form = new URLSearchParams({
    grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    scope: 'https://forms.office.com/.default',
  });
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  console.log('token minted OK\n');

  for (const path of [
    `formapi/api/forms('${FORM_ID}')`,
    `formapi/api/forms('${FORM_ID}')/questions`,
  ]) {
    const res = await fetch(`https://forms.office.com/${path}`, { headers: { Authorization: `Bearer ${access_token}` } });
    console.log(`=== GET ${path} ===`);
    console.log('status:', res.status);
    console.log('body:', (await res.text()).slice(0, 500));
    console.log('');
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
