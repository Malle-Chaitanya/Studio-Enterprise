/**
 * Probe PVA management API paths using api.powerplatform.com client-creds token.
 * Usage: cd server && npx tsx src/spikes/_diag_pva_api.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const BOT_ID = 'cd560e08-8e90-f111-8077-0022480a981d';
const BOT_SCHEMA = 'crf37_Confluenceagent';
const GATEWAY = 'https://powervamg.us-il101.gateway.prod.island.powerapps.com';
const ENV_ID = 'Default-807d6772-847c-40e2-9bec-e2c930b3a42e';
const ORG_URL = 'https://orga243378d.crm.dynamics.com';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId) throw new Error('No session');

  const tok = await clientCredsToken(s.tenantId, 'https://api.powerplatform.com');
  const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
  console.log('Token aud:', payload.aud, '| app:', payload.appid ?? payload.azp);

  const tenantId = payload.tid as string ?? s.tenantId ?? '';
  console.log('Tenant ID from token:', tenantId);

  const paths = [
    // PVA management API on gateway
    `/api/botmanagement/v1/environments/${ENV_ID}/bots/${BOT_ID}/knowledgesources`,
    `/api/botmanagement/v1/environments/${ENV_ID}/bots`,
    `/api/botmanagement/v1/bots/${BOT_ID}`,
    // powervirtualagents namespace
    `/powervirtualagents/environments/${ENV_ID}/bots/${BOT_ID}/knowledgesources?api-version=2022-03-01-preview`,
    `/powervirtualagents/environments/${ENV_ID}/bots?api-version=2022-03-01-preview`,
    // DL token via environment path
    `/powervirtualagents/environments/${ENV_ID}/bots/${BOT_ID}/directline/token?api-version=2022-03-01-preview`,
    `/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`,
  ];

  // Try with and without tenant-id header
  for (const [label, headers] of [
    ['no-tenant-hdr', { Authorization: `Bearer ${tok}`, Accept: 'application/json' }],
    ['with-tenant-hdr', { Authorization: `Bearer ${tok}`, Accept: 'application/json', 'x-ms-aad-tenant-id': tenantId, 'x-ms-client-tenant-id': tenantId }],
  ] as [string, Record<string, string>][]) {
    console.log(`\n--- api.powerplatform.com client-creds (${label}) ---`);
    for (const p of paths) {
      try {
        const r = await fetch(GATEWAY + p, { headers });
        const body = await r.text();
        console.log(`${r.status} ${p}`);
        if (body && r.status !== 404) console.log(body.slice(0, 300));
      } catch (e) { console.log(`ERROR ${p}: ${(e as Error).message}`); }
    }
  }

  // Also try the botmanagement API with the Dataverse delegated token (has user/tenant context)
  console.log('\n\n--- Trying botmanagement API with Dataverse DELEGATED token ---');
  const { delegatedDataverseToken } = await import('../auth/microsoft.js');
  const dvDel = await delegatedDataverseToken(s.tenantId, s.refreshToken ?? '', ORG_URL);
  if (dvDel) {
    const dvPayload = JSON.parse(Buffer.from(dvDel.token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    console.log('Dataverse delegated aud:', dvPayload.aud, '| upn:', dvPayload.upn ?? dvPayload.preferred_username);
    const botMgmtPaths = [
      `/api/botmanagement/v1/environments/${ENV_ID}/bots/${BOT_ID}/knowledgesources`,
      `/api/botmanagement/v1/environments/${ENV_ID}/bots`,
      `/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`,
      `/powervirtualagents/bots/${BOT_ID}/directline/token?api-version=2022-03-01-preview`,
    ];
    for (const p of botMgmtPaths) {
      try {
        const r = await fetch(GATEWAY + p, { headers: { Authorization: `Bearer ${dvDel.token}`, Accept: 'application/json' } });
        const body = await r.text();
        console.log(`\n${r.status} ${p}`);
        if (body) console.log(body.slice(0, 500));
      } catch (e) { console.log(`ERROR ${p}: ${(e as Error).message}`); }
    }
  } else {
    console.log('Could not obtain Dataverse delegated token.');
  }

  // Also try with PP environment API URL
  const ENV_API = 'https://default-807d6772-847c-40e2-9bec-e2c930b3a42e.environment.api.powerplatform.com';
  const envPaths = [
    `/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`,
    `/powervirtualagents/bots/${BOT_ID}/directline/token?api-version=2022-03-01-preview`,
  ];
  console.log(`\n\nTrying environment API URL: ${ENV_API}`);
  for (const p of envPaths) {
    try {
      const r = await fetch(ENV_API + p, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } });
      const body = await r.text();
      console.log(`${r.status} ${p}: ${body.slice(0, 300)}`);
    } catch (e) {
      console.log(`FETCH ERROR ${p}: ${(e as Error).message}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
