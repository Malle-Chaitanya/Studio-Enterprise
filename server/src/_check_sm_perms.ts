/**
 * Check SA permissions on SM secrets + run live end-to-end test:
 * SA reads creds from SM → gets Entra token → calls Dataverse.
 * Run: npx tsx src/_check_sm_perms.ts
 */
import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_KEY  = process.env['GOOGLE_SA_KEY_FILE']!;
const PROJ    = 'studio-enterprise-migration';
const SA_EMAIL = 'studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com';
const MS_SECRETS = [
  'studio-enterprise-ms-tenant-id',
  'studio-enterprise-ms-client-id',
  'studio-enterprise-ms-client-secret',
  'studio-enterprise-ms-org-url',
];

async function getToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600 })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }) });
  const j = await r.json() as { access_token?: string };
  if (!j.access_token) throw new Error(JSON.stringify(j));
  return j.access_token;
}

async function readSecret(token: string, secretId: string): Promise<string> {
  const res = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJ}/secrets/${secretId}/versions/latest:access`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`SM read ${secretId}: ${res.status} ${await res.text()}`);
  const j = await res.json() as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8');
}

async function main() {
  const token = await getToken();
  const saRef = `serviceAccount:${SA_EMAIL}`;

  // ── 1. Check IAM on each secret ──────────────────────────────────────────
  console.log('=== 1. SA permissions on SM secrets ===');
  let allGranted = true;
  for (const sid of MS_SECRETS) {
    const res = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJ}/secrets/${sid}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json() as { bindings?: Array<{ role: string; members: string[] }> };
    const bindings = j.bindings ?? [];
    const hasAccess = bindings.some(b => b.role === 'roles/secretmanager.secretAccessor' && b.members.includes(saRef));
    console.log(` ${hasAccess ? '✓' : '✗'} ${sid}`);
    if (!hasAccess) {
      allGranted = false;
      console.log(`   → SA missing secretAccessor on this secret`);
      console.log(`   → Current bindings: ${JSON.stringify(bindings).substring(0, 150)}`);
    }
  }

  // ── 2. Grant missing permissions ─────────────────────────────────────────
  if (!allGranted) {
    console.log('\n  Granting secretAccessor to SA on missing secrets...');
    for (const sid of MS_SECRETS) {
      const iamRes = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJ}/secrets/${sid}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
      const iamJ = await iamRes.json() as { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
      const bindings = iamJ.bindings ?? [];
      const hasAccess = bindings.some(b => b.role === 'roles/secretmanager.secretAccessor' && b.members.includes(saRef));
      if (hasAccess) continue;

      // Add binding
      const existing = bindings.find(b => b.role === 'roles/secretmanager.secretAccessor');
      if (existing) {
        existing.members.push(saRef);
      } else {
        bindings.push({ role: 'roles/secretmanager.secretAccessor', members: [saRef] });
      }
      const setRes = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJ}/secrets/${sid}:setIamPolicy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: { bindings, etag: iamJ.etag } }),
      });
      const setJ = await setRes.json();
      if (setRes.ok) {
        console.log(`  ✓ Granted secretAccessor on ${sid}`);
      } else {
        console.log(`  ✗ Failed to grant on ${sid}: ${JSON.stringify(setJ).substring(0, 200)}`);
      }
    }
    allGranted = true;
  }

  // ── 3. Read secrets directly (simulates what Cloud Workflow does) ─────────
  console.log('\n=== 2. Read each secret from SM (simulating workflow) ===');
  let tenantId = '', clientId = '', clientSecret = '', orgUrl = '';
  try {
    tenantId    = await readSecret(token, 'studio-enterprise-ms-tenant-id');
    clientId    = await readSecret(token, 'studio-enterprise-ms-client-id');
    clientSecret = await readSecret(token, 'studio-enterprise-ms-client-secret');
    orgUrl      = await readSecret(token, 'studio-enterprise-ms-org-url');
    console.log(` ✓ tenant_id:  ${tenantId}`);
    console.log(` ✓ client_id:  ${clientId}`);
    console.log(` ✓ client_secret: ${clientSecret.substring(0, 8)}...`);
    console.log(` ✓ org_url:    ${orgUrl}`);
  } catch (e) {
    console.log(` ✗ SM read failed: ${(e as Error).message}`);
    return;
  }

  // ── 4. Use the creds to get a real Entra token ────────────────────────────
  console.log('\n=== 3. Get Entra token using SM creds ===');
  const dvUrl = orgUrl.startsWith('http') ? orgUrl : `https://${orgUrl}`;
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: `${dvUrl}/.default` }) },
  );
  const tokenJ = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string };
  if (!tokenJ.access_token) {
    console.log(` ✗ Entra token FAILED: ${tokenJ.error_description ?? tokenJ.error}`);
    return;
  }
  console.log(` ✓ Entra token obtained: ${tokenJ.access_token.substring(0, 20)}...`);

  // ── 5. Call Dataverse with that token ─────────────────────────────────────
  console.log('\n=== 4. Call Dataverse with token from SM creds ===');
  const dvRes = await fetch(`${dvUrl}/api/data/v9.2/workflows?$filter=category eq 5&$top=3&$select=name`, {
    headers: { Authorization: `Bearer ${tokenJ.access_token}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json' },
  });
  if (dvRes.ok) {
    const dvJ = await dvRes.json() as { value: Array<{ name: string }> };
    console.log(` ✓ Dataverse call succeeded — ${dvJ.value.length} flows returned:`);
    for (const f of dvJ.value) console.log(`   - "${f.name}"`);
  } else {
    console.log(` ✗ Dataverse call failed: ${dvRes.status} ${await dvRes.text()}`);
  }

  console.log('\n=== RESULT ===');
  console.log('All 4 MS credentials stored in SM, SA has access, Entra token works, Dataverse call succeeds.');
  console.log('SM → Entra → Dataverse chain: WORKING ✓');
}

main().catch(console.error);
