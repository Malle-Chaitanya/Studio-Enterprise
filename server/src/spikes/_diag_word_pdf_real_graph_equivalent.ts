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

  // find a real .docx in erik's drive
  const listRes = await fetch("https://graph.microsoft.com/v1.0/users/erik@filefuze.co/drive/root/children?$filter=endswith(name,'.docx')&$top=5", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const listBody = await listRes.json();
  console.log('search .docx ->', listRes.status, JSON.stringify(listBody).slice(0, 800));

  const items = (listBody as any).value ?? [];
  if (!items.length) {
    console.log('No .docx found at drive root — trying a full search instead');
    const searchRes = await fetch("https://graph.microsoft.com/v1.0/users/erik@filefuze.co/drive/root/search(q='.docx')?$top=5", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    console.log('search() ->', searchRes.status, (await searchRes.text()).slice(0, 800));
    return;
  }

  const item = items[0];
  console.log('\nTesting real Graph PDF-conversion endpoint on:', item.name, item.id);
  const pdfRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/erik@filefuze.co/drive/items/${item.id}/content?format=pdf`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  console.log('GET content?format=pdf ->', pdfRes.status, pdfRes.headers.get('content-type'), pdfRes.headers.get('content-length'));
  if (!pdfRes.ok) console.log(await pdfRes.text());
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
