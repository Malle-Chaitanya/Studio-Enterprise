import { readFileSync } from 'fs';
import { createSign } from 'crypto';

async function getToken(): Promise<string> {
  const key = JSON.parse(readFileSync(process.env['GOOGLE_SA_KEY_FILE']!, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600 })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }) });
  const j = await r.json() as { access_token?: string };
  return j.access_token!;
}

const proj = 'studio-enterprise-migration';

async function main() {
  const token = await getToken();

  const res = await fetch(`https://secretmanager.googleapis.com/v1/projects/${proj}/secrets?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json() as { secrets?: Array<{ name: string }> };
  const secrets = j.secrets ?? [];
  console.log(`\n=== Secrets in GCP Secret Manager (${proj}) ===`);
  console.log(`Total: ${secrets.length}`);
  for (const s of secrets) console.log(` - ${s.name.split('/').pop()}`);

  const msSecrets = [
    'studio-enterprise-ms-tenant-id',
    'studio-enterprise-ms-client-id',
    'studio-enterprise-ms-client-secret',
    'studio-enterprise-ms-org-url',
  ];
  console.log('\n=== MS Credentials in SM ===');
  for (const secretId of msSecrets) {
    const v = await fetch(`https://secretmanager.googleapis.com/v1/projects/${proj}/secrets/${secretId}/versions/latest:access`, { headers: { Authorization: `Bearer ${token}` } });
    if (v.ok) {
      const vj = await v.json() as { payload?: { data?: string } };
      const val = Buffer.from(vj.payload?.data ?? '', 'base64').toString('utf8');
      console.log(` ✓ ${secretId} = ${val.substring(0, 25)}...`);
    } else {
      console.log(` ✗ ${secretId} - MISSING (${v.status})`);
    }
  }
}

main().catch(console.error);
