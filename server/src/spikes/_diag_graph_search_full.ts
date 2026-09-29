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
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' });
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const res = await fetch('https://graph.microsoft.com/v1.0/search/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ entityTypes: ['driveItem'], query: { queryString: 'Document.docx' }, from: 0, size: 5, region: 'NAM' }],
    }),
  });
  const json: any = await res.json();
  const hit = json.value[0].hitsContainers[0].hits[0];
  console.log(JSON.stringify(hit.resource, null, 2));

  // now try converting using driveId + itemId directly
  const driveId = hit.resource.parentReference?.driveId;
  const itemId = hit.resource.id;
  console.log('\ndriveId:', driveId, 'itemId:', itemId);
  if (driveId) {
    const pdfRes = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content?format=pdf`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    console.log('convert via /drives/{driveId}/items/{id} ->', pdfRes.status, pdfRes.headers.get('content-length'));
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
