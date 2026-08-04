import { readFileSync } from 'fs';
import { createSign } from 'crypto';

async function run() {
  const key = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600 })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }) });
  const token = (await tr.json()).access_token;
  const base = 'https://us-central1-dialogflow.googleapis.com/v3beta1/projects/studio-enterprise-migration/locations/us-central1/agents/1ba8f171-f386-4ddd-8891-1a366193d186';
  const r1 = await fetch(`${base}/tools`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'uri-test', description: 'test', openApiSpec: { uri: 'https://petstore3.swagger.io/api/v3/openapi.json' } }) });
  console.log('openApiSpec uri:', r1.status, (await r1.text()).substring(0, 300));
}
run().catch(console.error);
export {};
