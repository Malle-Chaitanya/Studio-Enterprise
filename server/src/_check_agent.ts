import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const key = JSON.parse(readFileSync(process.env['GOOGLE_SA_KEY_FILE']!, 'utf8')) as { client_email: string; private_key: string };
const now = Math.floor(Date.now() / 1000);
const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const p = Buffer.from(JSON.stringify({
  iss: key.client_email, sub: key.client_email,
  aud: 'https://oauth2.googleapis.com/token',
  scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/dialogflow',
  iat: now, exp: now + 3600,
})).toString('base64url');
const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
const tr = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }),
});
const { access_token } = await tr.json() as { access_token: string };

const AGENT_ID = '1ed6ef2c-671d-4c9f-9360-6fee78e4e1c4';
const BASE = `https://us-central1-dialogflow.googleapis.com/v3beta1/projects/studio-enterprise-migration/locations/us-central1/agents/${AGENT_ID}`;

// Get agent
const ag = await fetch(BASE, { headers: { Authorization: `Bearer ${access_token}` } });
const agBody = await ag.json() as Record<string, unknown>;
console.log('startPlaybook:', agBody['startPlaybook'] ?? 'NOT SET');
console.log('startFlow:', agBody['startFlow'] ?? 'not set');

// List playbooks
const pb = await fetch(`${BASE}/playbooks`, { headers: { Authorization: `Bearer ${access_token}` } });
const pbBody = await pb.json() as { playbooks?: Array<{ name: string; displayName: string }> };
console.log('Playbooks:', (pbBody.playbooks ?? []).map(p => `${p.displayName} (${p.name.split('/').pop()})`));

// Set startPlaybook if needed
const playbook = (pbBody.playbooks ?? [])[0];
if (playbook && !agBody['startPlaybook']) {
  console.log('\nSetting startPlaybook...');
  const patch = await fetch(`${BASE}?updateMask=startPlaybook`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startPlaybook: playbook.name }),
  });
  const patchBody = await patch.json() as Record<string, unknown>;
  console.log('PATCH result startPlaybook:', patchBody['startPlaybook'] ?? patchBody['error'] ?? 'unknown');
}

export {};
