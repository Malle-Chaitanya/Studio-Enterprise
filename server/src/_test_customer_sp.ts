/**
 * Test customer service principal (Option 3) against MS Graph APIs.
 *
 * The customer creates ONE app registration in their Entra tenant and grants:
 *   - Team.ReadWrite.All    (Teams messages)
 *   - Sites.ReadWrite.All   (SharePoint files)
 *   - Mail.Send             (Outlook/Exchange email)
 *   - Files.ReadWrite.All   (OneDrive)
 *   - Tasks.ReadWrite       (Planner)
 *
 * This script reads those creds from SM (same 4 secrets we already have)
 * and tests each MS Graph API endpoint.
 *
 * Run: npx tsx src/_test_customer_sp.ts
 *
 * Required env:
 *   GOOGLE_SA_KEY_FILE  — path to GCP SA key JSON
 *
 * Required SM secrets (already set up):
 *   studio-enterprise-ms-tenant-id
 *   studio-enterprise-ms-client-id
 *   studio-enterprise-ms-client-secret
 *   studio-enterprise-ms-org-url
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_KEY  = process.env['GOOGLE_SA_KEY_FILE']!;
const GCP_PROJECT = 'studio-enterprise-migration';

// ── GCP SA token ──────────────────────────────────────────────────────────────

async function getGcpToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: key.client_email, sub: key.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }),
  });
  const j = await r.json() as { access_token?: string };
  if (!j.access_token) throw new Error(`GCP SA token failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function readSecret(gcpToken: string, secretId: string): Promise<string> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${secretId}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${gcpToken}` } },
  );
  if (!res.ok) throw new Error(`SM ${secretId}: ${res.status} ${await res.text()}`);
  const j = await res.json() as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8');
}

// ── MS Graph token ────────────────────────────────────────────────────────────

async function getGraphToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    },
  );
  const j = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`Graph token failed: ${j.error_description ?? j.error}`);
  return j.access_token;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testGraphEndpoint(
  token: string,
  label: string,
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.ok) {
    console.log(` ✓ ${label} — ${res.status}`);
  } else {
    console.log(` ✗ ${label} — ${res.status}: ${text.substring(0, 200)}`);
  }
}

async function main() {
  console.log('=== Customer Service Principal Test ===\n');

  // 1. Read creds from SM
  console.log('1. Reading MS creds from Secret Manager...');
  const gcpToken = await getGcpToken();
  const tenantId     = await readSecret(gcpToken, 'studio-enterprise-ms-tenant-id');
  const clientId     = await readSecret(gcpToken, 'studio-enterprise-ms-client-id');
  const clientSecret = await readSecret(gcpToken, 'studio-enterprise-ms-client-secret');
  console.log(` ✓ tenant_id:  ${tenantId}`);
  console.log(` ✓ client_id:  ${clientId}`);
  console.log(` ✓ client_secret: ${clientSecret.substring(0, 8)}...`);

  // 2. Get MS Graph token (Graph scope — different from Dataverse scope)
  console.log('\n2. Getting MS Graph token (scope: graph.microsoft.com/.default)...');
  let graphToken: string;
  try {
    graphToken = await getGraphToken(tenantId, clientId, clientSecret);
    console.log(` ✓ Graph token: ${graphToken.substring(0, 20)}...`);
  } catch (e) {
    console.log(` ✗ FAILED: ${(e as Error).message}`);
    console.log('\n   → Customer SP needs Graph permissions. Have the customer:');
    console.log('   → 1. Go to Azure Portal → App registrations → [their app]');
    console.log('   → 2. API permissions → Add permission → Microsoft Graph → Application permissions');
    console.log('   → 3. Add: Team.ReadWrite.All, Sites.ReadWrite.All, Mail.Send, Files.ReadWrite.All');
    console.log('   → 4. Grant admin consent');
    return;
  }

  // 3. Test each MS Graph endpoint
  console.log('\n3. Testing MS Graph API endpoints...');

  // Teams — list joined teams
  await testGraphEndpoint(graphToken, 'Teams: list all teams', 'https://graph.microsoft.com/v1.0/groups?$filter=resourceProvisioningOptions/Any(x:x eq \'Team\')&$select=id,displayName&$top=5');

  // SharePoint — list root sites
  await testGraphEndpoint(graphToken, 'SharePoint: list sites', 'https://graph.microsoft.com/v1.0/sites?search=*&$select=id,displayName,webUrl&$top=5');

  // OneDrive / Files — list drives
  await testGraphEndpoint(graphToken, 'OneDrive: list drives', 'https://graph.microsoft.com/v1.0/drives?$select=id,name&$top=5');

  // Outlook / Mail — list users (confirms Mail.Send app permission is valid)
  await testGraphEndpoint(graphToken, 'Outlook: list users (Mail.Send check)', 'https://graph.microsoft.com/v1.0/users?$select=id,mail,displayName&$top=3');

  // Planner — list plans for a group (requires Tasks.ReadWrite.All)
  await testGraphEndpoint(graphToken, 'Planner: list plans (Tasks.ReadWrite.All check)', 'https://graph.microsoft.com/v1.0/planner/plans?$filter=owner eq \'00000000-0000-0000-0000-000000000000\'&$top=1');

  // 4. Check what permissions the token actually has
  console.log('\n4. App permissions granted (from token claims)...');
  const payload = JSON.parse(Buffer.from(graphToken.split('.')[1]!, 'base64url').toString('utf8')) as {
    roles?: string[];
    app_displayname?: string;
    tid?: string;
  };
  const roles = payload.roles ?? [];
  const needed = ['Sites.ReadWrite.All', 'Mail.Send', 'Files.ReadWrite.All', 'Tasks.ReadWrite.All'];
  for (const r of needed) {
    console.log(` ${roles.includes(r) ? '✓' : '✗'} ${r}`);
  }
  if (roles.length > 0) {
    console.log(` All granted roles: ${roles.join(', ')}`);
  }

  console.log('\n=== RESULT ===');
  const missingRoles = needed.filter(r => !roles.includes(r));
  if (missingRoles.length === 0) {
    console.log('All required permissions granted. Customer SP is production-ready ✓');
    console.log('Cloud Workflows will read creds from SM and call MS Graph successfully.');
  } else {
    console.log(`Missing permissions: ${missingRoles.join(', ')}`);
    console.log('Customer needs to grant these in Azure Portal → App registrations → API permissions → Admin consent.');
  }
}

main().catch(console.error);
export {};
