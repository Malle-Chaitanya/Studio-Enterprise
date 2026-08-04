/**
 * Diagnostic: list Dialogflow CX agents and Agentspace engines.
 * Run: npx tsx src/_diag_gemini_agents.ts
 */
import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_KEY_FILE = process.env['GOOGLE_SA_KEY_FILE']!;
const GCP_PROJECT = 'studio-enterprise-migration';

async function getGcpToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as { client_email: string; private_key: string };
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
  if (!j.access_token) throw new Error(JSON.stringify(j));
  return j.access_token;
}

async function main() {
  const token = await getGcpToken();
  console.log('GCP token OK\n');
  const headers = { Authorization: `Bearer ${token}` };

  // 1. Dialogflow CX in global
  console.log('=== Dialogflow CX agents (global) ===');
  const cxG = await (await fetch(`https://dialogflow.googleapis.com/v3/projects/${GCP_PROJECT}/locations/global/agents?pageSize=50`, { headers })).json();
  console.log(JSON.stringify(cxG, null, 2).substring(0, 1000));

  // 2. Dialogflow CX in us-central1
  console.log('\n=== Dialogflow CX agents (us-central1) ===');
  const cxUS = await (await fetch(`https://dialogflow.googleapis.com/v3/projects/${GCP_PROJECT}/locations/us-central1/agents?pageSize=50`, { headers })).json();
  console.log(JSON.stringify(cxUS, null, 2).substring(0, 1000));

  // 3. Discovery Engine / Agentspace
  console.log('\n=== Discovery Engine (Agentspace) ===');
  const de = await (await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${GCP_PROJECT}/locations/global/collections/default_collection/engines?pageSize=20`, { headers })).json() as { engines?: Array<{ name: string; displayName: string }> };
  console.log(JSON.stringify(de, null, 2).substring(0, 1000));

  // 4. Also check existing Gemini agent via the migration system
  console.log('\n=== Checking known engine (from gemini.ts pattern) ===');
  const deEngines = de.engines ?? [];
  for (const eng of deEngines) {
    console.log(`Engine: ${eng.name} "${eng.displayName}"`);
    const assistants = await (await fetch(`https://discoveryengine.googleapis.com/v1alpha/${eng.name}/assistants?pageSize=20`, { headers })).json();
    console.log('  Assistants:', JSON.stringify(assistants, null, 2).substring(0, 400));
  }
}

main().catch(console.error);
export {};
