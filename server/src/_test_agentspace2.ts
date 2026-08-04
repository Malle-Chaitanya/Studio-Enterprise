import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const key = JSON.parse(readFileSync(process.env['GOOGLE_SA_KEY_FILE']!, 'utf8')) as { client_email: string; private_key: string };
const now = Math.floor(Date.now() / 1000);
const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const p = Buffer.from(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600 })).toString('base64url');
const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }) });
const { access_token } = await tr.json() as { access_token: string };
const hdrs = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

const PROJECT = '521161651560';
const ENGINE = '8803228190372559793';
const CLOUD_RUN = 'https://studio-enterprise-server-231705905417.us-central1.run.app';

const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

console.log('=== Listing agents ===');
const listRes = await fetch(BASE, { headers: hdrs });
const listBody = await listRes.json() as Record<string, unknown>;
console.log('Status:', listRes.status);
console.log(JSON.stringify(listBody, null, 2).substring(0, 800));

if (listRes.status === 403 || listRes.status === 401) {
  console.log('\n⚠ SA does not have access to project 521161651560 (sonorous-lightning-t224x)');
  console.log('Need to grant Discovery Engine Admin to:');
  console.log('  studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com');
  console.log('on project sonorous-lightning-t224x');
} else if (listRes.ok) {
  const agents = (listBody['agents'] as Array<{ name: string; displayName: string }> | undefined) ?? [];
  const existing = agents.find(a => a.displayName === 'Studio Enterprise Migration Agent');
  const agentBase = existing ? existing.name : null;

  if (!agentBase) {
    console.log('\n=== Creating agent ===');
    const createRes = await fetch(BASE, { method: 'POST', headers: hdrs, body: JSON.stringify({ displayName: 'Studio Enterprise Migration Agent', description: 'Triggers migrated Cloud Workflows via CloudFuze Studio Migrate.' }) });
    const created = await createRes.json() as { name?: string; error?: { message: string } };
    console.log('Create status:', createRes.status, created.name ?? created.error?.message);

    if (created.name) {
      console.log('\n=== Adding tool ===');
      const toolSpec = { openapi: '3.0.0', info: { title: 'create-task', version: '1.0.0' }, servers: [{ url: CLOUD_RUN }], paths: { '/api/workflows/execute': { post: { operationId: 'create_task', summary: 'Create a migration task', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { workflow: { type: 'string' }, project: { type: 'string' }, region: { type: 'string' }, args: { type: 'object', properties: { task_title: { type: 'string' }, assigned_to: { type: 'string' }, priority: { type: 'string' } } } } } } } }, responses: { '200': { description: 'Task created' } } } } } };
      const patchRes = await fetch(`${created.name}?updateMask=tools`, { method: 'PATCH', headers: hdrs, body: JSON.stringify({ tools: [{ displayName: 'Create Task', openApiToolSpec: JSON.stringify(toolSpec) }] }) });
      const patchBody = await patchRes.json() as Record<string, unknown>;
      console.log('Patch status:', patchRes.status);
      console.log('Tools count:', ((patchBody['tools'] as unknown[]) ?? []).length);
      console.log('\n✅ Agent ready in business.gemini.google → Agents → Studio Enterprise Migration Agent');
    }
  } else {
    console.log('Agent already exists:', agentBase);
  }
}

export {};
