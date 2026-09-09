/** Find Erik's real account in the tenant, then search his OneDrive specifically
 *  for the Deal Desk folder / rate sheet file, using the already-proven-working
 *  credentials. Never logs secret/token values.
 *  npx tsx src/spikes/_diag_find_erik_onedrive.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SECRET_PROJECT = 'studio-enterprise-migration';
const saToken = await getSaToken();

async function readSecret(secretId: string): Promise<string> {
  const url = `https://secretmanager.googleapis.com/v1/projects/${SECRET_PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

const tenantId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-tenant-id');
const clientId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-id');
const clientSecret = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-secret');

const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }),
});
const { access_token } = (await tokenRes.json()) as { access_token: string };
const gh = { Authorization: `Bearer ${access_token}` };

// Find Erik's real account.
const usersRes = await fetch(
  `https://graph.microsoft.com/v1.0/users?$filter=${encodeURIComponent("startswith(displayName,'erik') or startswith(userPrincipalName,'erik') or startswith(givenName,'erik')")}&$select=userPrincipalName,displayName`,
  { headers: gh },
);
const usersJson = (await usersRes.json()) as { value?: Array<{ userPrincipalName: string; displayName: string }>; error?: unknown };
console.log('Erik search result:', JSON.stringify(usersJson).slice(0, 1000));

const eriks = usersJson.value ?? [];
for (const u of eriks) {
  console.log(`\n=== Searching ${u.displayName} <${u.userPrincipalName}>'s OneDrive for "Deal Desk" ===`);
  const searchRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(u.userPrincipalName)}/drive/root/search(q='Deal Desk')`,
    { headers: gh },
  );
  if (!searchRes.ok) {
    console.log(`  search failed: ${searchRes.status} ${(await searchRes.text()).slice(0, 300)}`);
    continue;
  }
  const searchJson = (await searchRes.json()) as { value?: Array<{ name: string; id: string; folder?: unknown; webUrl: string }> };
  console.log(`  ${searchJson.value?.length ?? 0} match(es):`);
  for (const f of searchJson.value ?? []) console.log(`    - ${f.name}${f.folder ? ' [folder]' : ''} (id: ${f.id})`);
}
process.exit(0);
