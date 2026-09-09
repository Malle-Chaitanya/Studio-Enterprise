/** Upload the GENERIC translator's real output for GetRateSheetBand and test it live —
 *  the Excel /workbook/tables/{id}/range binding and the generic Query-compiler-produced
 *  JavaScript have never been live-tested before this. Needs a real ms-graph AuthConfig
 *  named "ms_graph" (the generic translator's deterministic name) to exist first — reuse
 *  the one already proven this session by creating it under that exact name if missing.
 *  npx tsx src/spikes/_diag_upload_test_generic_getratesheetband.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { translateFlow } from '../services/flowMapper.js';
import { getSaToken } from '../auth/google.js';
import type { Session } from '../sessionStore.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'GetRateSheetBand_Generic_v1';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId || !s.dvOrgUrl) throw new Error('NO_USABLE_SESSION');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const bots = await listBots(s.dvOrgUrl, token);
const bot = bots.find((b) => b.name.trim().toLowerCase() === 'deal desk');
if (!bot) throw new Error('Deal Desk not found');
const ir = await extractAgent(s.dvOrgUrl, token, bot);
const flow = ir.flows?.find((f) => f.name === 'GetRateSheetBand');
if (!flow) throw new Error('GetRateSheetBand not found in extracted IR');

const result = translateFlow(flow, { integrationName: INTEGRATION });
console.log('authConfigsNeeded:', JSON.stringify(result.authConfigsNeeded));

const gToken = await getSaToken();

// AuthConfig identity is server-generated (a UUID-like resource name) -- it's matched by
// `displayName` when referenced from a GenericRestV2Task's `authConfigName`, per the
// proven working pattern (_diag_create_msgraph_authconfig.ts). So "does it exist" means
// "does an authConfig with this displayName exist", found via list+filter, not a direct GET.
const authConfigName = result.authConfigsNeeded[0]?.authConfigName ?? 'ms_graph';
const listRes = await fetch(
  `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/authConfigs`,
  { headers: { Authorization: `Bearer ${gToken}` } },
);
const listJson = (await listRes.json()) as { authConfigs?: { displayName?: string }[] };
const exists = (listJson.authConfigs ?? []).some((a) => a.displayName === authConfigName);
console.log(`AuthConfig "${authConfigName}" exists: ${exists}`);
if (!exists) {
  console.log('Creating it (reusing the same ms-graph client credentials already proven this session)...');
  async function sec(n: string) {
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/studio-enterprise-migration/secrets/${n}/versions/latest:access`, { headers: { Authorization: `Bearer ${gToken}` } });
    const j = (await r.json()) as { payload?: { data?: string } };
    return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
  }
  const tenantId = await sec('studio-enterprise-ms-graph-tenant-id');
  const clientId = await sec('studio-enterprise-ms-graph-client-id');
  const clientSecret = await sec('studio-enterprise-ms-graph-client-secret');
  const createRes = await fetch(
    `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/authConfigs`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: authConfigName,
        decryptedCredential: {
          credentialType: 'OAUTH2_CLIENT_CREDENTIALS',
          oauth2ClientCredentials: {
            clientId,
            clientSecret,
            tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
            scope: 'https://graph.microsoft.com/.default',
            requestType: 'REQUEST_BODY',
          },
        },
      }),
    },
  );
  console.log('Create AuthConfig status:', createRes.status);
  if (createRes.status !== 200) console.log(await createRes.text());
}

const uploadRes = await fetch(
  `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}/versions:upload`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(result.integrationDefinition), fileFormat: 'JSON' }),
  },
);
console.log('Upload status:', uploadRes.status);
const uploadJson = (await uploadRes.json()) as { integrationVersion?: { name?: string } };
if (!uploadJson.integrationVersion?.name) {
  console.log(JSON.stringify(uploadJson).slice(0, 1500));
  process.exit(0);
}
const versionId = uploadJson.integrationVersion.name.split('/').pop();
const base = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}`;
const publishRes = await fetch(`${base}/versions/${versionId}:publish`, { method: 'POST', headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' }, body: '{}' });
console.log('Publish status:', publishRes.status);
if (publishRes.status !== 200) console.log(await publishRes.text());

for (const NewLimit of ['500000', '2000000', '7000000']) {
  const execRes = await fetch(
    `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
    { method: 'POST', headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ NewLimit }) },
  );
  console.log(`\nExecute (NewLimit=${NewLimit}) status:`, execRes.status);
  console.log((await execRes.text()).slice(0, 1500));
}
process.exit(0);
