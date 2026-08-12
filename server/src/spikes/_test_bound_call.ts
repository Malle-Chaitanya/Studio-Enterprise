/**
 * Does a bound tool spec actually produce a WORKING call?
 *
 * Builds the specs exactly as the deploy path does, then makes the request from here with
 * the customer's stored credentials. Proving the URL, the fixed arguments and the auth
 * before a redeploy separates "the binding is wrong" from "the container is wrong" — two
 * failures that look identical once they are inside a Reasoning Engine.
 *
 * Read-only: GETs only, and it refuses to run a spec whose method is not GET.
 * Credential VALUES are read into memory to sign the request and never printed.
 *
 * npx tsx src/spikes/_test_bound_call.ts <agent name fragment> [envUrl]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';

const NAME = process.argv[2] ?? 'confluence';
const ENV = process.argv[3] ?? 'https://orga243378d.crm.dynamics.com';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string; environments?: Array<{ url: string; id: string }> } | null;
const tenantId = cache!.tenantId!;
const envId = (cache!.environments ?? []).find((e) => e.url.replace(/\/$/, '') === ENV.replace(/\/$/, ''))!.id;
const scope = `ms-${tenantId}`;

const dvToken = await clientCredsToken(tenantId, ENV);
const bots = await listBots(ENV, dvToken);
const bot = bots.find((b) => b.name.toLowerCase().includes(NAME.toLowerCase()));
if (!bot) {
  console.error(`no agent matching "${NAME}" in ${ENV}. Agents: ${bots.map((b) => b.name).join(' | ')}`);
  process.exit(1);
}
console.log(`agent: ${bot.name}\n`);

const ir = await extractAgent(ENV, dvToken, bot);
const build = await buildBoundToolSpecs(ir, { tenantId, environmentId: envId, scope }, { dataverseOrgUrl: ENV });

for (const note of build.notes) console.log(`note [${note.status}] ${note.component}: ${note.detail}`);
if (!build.byConnector.size) {
  console.log('no bound operations for this agent');
  process.exit(0);
}

// Credentials: read the same secrets the container would, via the stored ids.
const saToken = await getSaToken();
const records = await listConnectorCredentials('default');
async function secret(connectorId: string, field: string): Promise<string | undefined> {
  const rec = records.find((r) => r.connectorId === connectorId) ?? records.find((r) => r.secretIds?.[field]);
  const id = rec?.secretIds?.[field];
  if (!id || !rec) return undefined;
  const got = await getEntraSecret(saToken, `projects/${rec.project}/secrets/${id}/versions/latest`);
  return got.ok ? got.plaintext : undefined;
}

for (const [connectorId, specs] of build.byConnector) {
  for (const spec of specs) {
    console.log(`\n── ${spec.toolName}  (${connectorId} ${spec.operationId})`);
    console.log(`   ${spec.method} ${spec.urlTemplate}`);
    console.log(`   fixed:   ${JSON.stringify(spec.fixedArgs)}`);
    console.log(`   model:   ${spec.modelArgs.map((a) => `${a.name}${a.required ? '*' : ''}`).join(', ') || '(none)'}`);
    console.log(`   context: ${spec.contextRequired.join(', ') || '(none)'}  auth=${spec.auth}`);
    if (spec.method !== 'GET') {
      console.log('   SKIPPED — this probe only issues GETs');
      continue;
    }

    // Resolve context exactly as the container does.
    let url = spec.urlTemplate;
    for (const c of spec.contextRequired) {
      let value = spec.contextValues[c];
      if (!value && c === 'cloudId') {
        const base = (await secret(connectorId, 'base_url'))?.replace(/\/$/, '');
        if (!base) { console.log('   no base_url secret — cannot resolve cloudId'); break; }
        const info = await fetch(`${base}/_edge/tenant_info`).then((r) => r.json() as Promise<{ cloudId?: string }>);
        value = info.cloudId ?? '';
        console.log(`   resolved cloudId from ${base}/_edge/tenant_info: ${value ? 'ok' : 'EMPTY'}`);
      }
      if (!value) { console.log(`   unresolved context ${c}`); break; }
      url = url.replace(`{${c}}`, value);
    }

    const query = new URLSearchParams();
    for (const [name, meta] of Object.entries(spec.fixedArgs)) {
      if (meta.in === 'path') url = url.replace(`{${name}}`, encodeURIComponent(meta.value));
      else if (meta.in === 'query') query.set(name, meta.value);
    }
    if ([...url.matchAll(/\{(\w+)\}/g)].length) {
      console.log(`   unfilled placeholders: ${url}`);
      continue;
    }
    // A small page keeps the probe cheap and the output readable.
    if (spec.modelArgs.some((a) => a.name === 'limit')) query.set('limit', '2');
    const finalUrl = query.toString() ? `${url}?${query}` : url;

    let authHeader = '';
    if (spec.auth === 'atlassian-basic') {
      const email = await secret(connectorId, 'email');
      const token = await secret(connectorId, 'api_token');
      if (!email || !token) { console.log('   missing Atlassian credentials'); continue; }
      authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    } else if (spec.auth === 'bearer-token') {
      const key = (await secret(connectorId, 'api_key')) ?? (await secret('shared_hubspotcrmv2', 'api_key'));
      if (!key) { console.log('   missing bearer token'); continue; }
      authHeader = `Bearer ${key}`;
    } else {
      console.log(`   auth kind ${spec.auth} not exercised by this probe`);
      continue;
    }

    const res = await fetch(finalUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    const text = await res.text();
    console.log(`   -> ${res.status} ${res.ok ? 'OK' : 'FAILED'}  ${text.slice(0, 220).replace(/\s+/g, ' ')}`);
  }
}
process.exit(0);
