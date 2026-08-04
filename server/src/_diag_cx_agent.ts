/**
 * Check CX Test Agent's existing tools and playbooks.
 * Run: npx tsx src/_diag_cx_agent.ts
 */
import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_KEY_FILE = process.env['GOOGLE_SA_KEY_FILE']!;
const AGENT = 'projects/studio-enterprise-migration/locations/global/agents/2aad4f89-1ea9-4132-86cc-530bf1fe0ef1';

async function getGcpToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600 })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }) });
  const j = await r.json() as { access_token?: string };
  if (!j.access_token) throw new Error(JSON.stringify(j));
  return j.access_token;
}

async function main() {
  const token = await getGcpToken();
  const hdr = { Authorization: `Bearer ${token}` };
  const base = `https://dialogflow.googleapis.com/v3/${AGENT}`;

  console.log('=== Tools ===');
  const tools = await (await fetch(`${base}/tools?pageSize=50`, { headers: hdr })).json();
  console.log(JSON.stringify(tools, null, 2).substring(0, 1500));

  console.log('\n=== Playbooks ===');
  const pb = await (await fetch(`${base}/playbooks?pageSize=20`, { headers: hdr })).json();
  console.log(JSON.stringify(pb, null, 2).substring(0, 1500));

  console.log('\n=== Flows ===');
  const flows = await (await fetch(`${base}/flows?pageSize=20`, { headers: hdr })).json();
  console.log(JSON.stringify(flows, null, 2).substring(0, 800));
}

main().catch(console.error);
