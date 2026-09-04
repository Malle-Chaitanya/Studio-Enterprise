/** Use the already-working MS Graph credentials to find real users in the tenant,
 *  then search their OneDrive for the rate sheet file -- proving live access without
 *  needing the exact right user guessed up front. Never logs secret/token values.
 *  npx tsx src/spikes/_diag_find_onedrive_file.ts */
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

// List real users in the tenant.
const usersRes = await fetch('https://graph.microsoft.com/v1.0/users?$select=userPrincipalName,displayName&$top=25', { headers: gh });
const usersJson = (await usersRes.json()) as { value?: Array<{ userPrincipalName: string; displayName: string }>; error?: unknown };
if (!usersJson.value) {
  console.log('Users list failed:', JSON.stringify(usersJson).slice(0, 500));
  process.exit(0);
}
console.log(`Found ${usersJson.value.length} user(s) in tenant:`);
for (const u of usersJson.value) console.log(`  - ${u.displayName} <${u.userPrincipalName}>`);

// Search each user's OneDrive for the file.
console.log('\nSearching each user\'s OneDrive for "deal desk"...');
for (const u of usersJson.value) {
  const searchRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(u.userPrincipalName)}/drive/root/search(q='deal desk')`,
    { headers: gh },
  );
  if (!searchRes.ok) {
    console.log(`  ${u.userPrincipalName}: search failed (${searchRes.status})`);
    continue;
  }
  const searchJson = (await searchRes.json()) as { value?: Array<{ name: string; id: string; webUrl: string }> };
  if (searchJson.value?.length) {
    console.log(`  ✅ ${u.userPrincipalName}: FOUND ${searchJson.value.length} match(es):`);
    for (const f of searchJson.value) console.log(`      - ${f.name} (id: ${f.id})`);
  } else {
    console.log(`  ${u.userPrincipalName}: no matches`);
  }
}
process.exit(0);
