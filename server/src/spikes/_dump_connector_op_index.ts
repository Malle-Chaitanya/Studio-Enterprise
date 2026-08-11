/**
 * Distill each connector's Power Apps swagger into a small, committable operation index.
 *
 * The raw swaggers are large (SharePoint 141 ops, Power Platform Admin 189) and mostly
 * response schemas we never use. What the emitter needs per operation is the verb, the
 * path, and the parameters — so that is what we store, in a shape stable enough to diff
 * when Microsoft changes a connector.
 *
 * Output: src/connectors/fixtures/<connectorId>.ops.json
 * Read-only against Power Apps. npx tsx src/spikes/_dump_connector_op_index.ts [envUrl]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const ENV = process.argv[2] ?? 'https://org32322095.crm.dynamics.com';
const IDS = [
  'shared_confluence',
  'shared_jira',
  'shared_commondataserviceforapps',
  'shared_hubspotcrm',
  'shared_hubspotcrmv2',
  'shared_hubspotsettingsv2',
  'shared_powerplatformadminv2',
  'shared_googledrive',
  'shared_sharepointonline',
  'shared_teams',
  'shared_onedrive',
  'shared_office365',
];

await connectMongo();
const row = (await getDb()
  .collection('environmentsCache')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as { tenantId?: string; environments?: Array<{ url: string; id: string }> } | null;
const tenant = row?.tenantId;
const env = (row?.environments ?? []).find((e) => e.url.replace(/\/$/, '') === ENV.replace(/\/$/, ''));
if (!tenant || !env?.id) {
  console.error('no cached tenant/environment');
  process.exit(1);
}
const paToken = await clientCredsToken(tenant, 'https://service.powerapps.com');
mkdirSync('src/connectors/fixtures', { recursive: true });

for (const cid of IDS) {
  const res = await fetch(
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${cid}` +
      `?api-version=2016-11-01&$filter=environment eq '${env.id}'&$expand=swagger`,
    { headers: { Authorization: `Bearer ${paToken}` } },
  );
  if (!res.ok) {
    console.log(`${res.status}  ${cid}`);
    continue;
  }
  const json = (await res.json()) as any;
  const sw = json.properties?.swagger ?? {};
  const operations: Record<string, unknown> = {};
  for (const [p, verbs] of Object.entries<any>(sw.paths ?? {})) {
    for (const [verb, o] of Object.entries<any>(verbs ?? {})) {
      if (!o?.operationId) continue;
      operations[o.operationId] = {
        method: verb.toUpperCase(),
        path: p,
        summary: o.summary ?? '',
        deprecated: o.deprecated === true || o['x-ms-visibility'] === 'internal' ? true : undefined,
        parameters: (o.parameters ?? []).map((prm: any) => ({
          name: prm.name,
          in: prm.in,
          required: prm.required === true,
          type: prm.type ?? prm.schema?.type ?? 'object',
          visibility: prm['x-ms-visibility'] ?? undefined,
        })),
      };
    }
  }
  // Only the auth-shaping bits of connectionParameters: enough to say WHAT credential the
  // vendor wants, never a credential value (nothing here is tenant-specific or secret).
  const cp = json.properties?.connectionParameters ?? {};
  const authParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries<any>(cp)) {
    authParams[k] = {
      type: v?.type,
      identityProvider: v?.oAuthSettings?.identityProvider,
      resource:
        v?.oAuthSettings?.customParameters?.resourceUriAAD?.value ??
        v?.oAuthSettings?.customParameters?.ResourceUriAAD?.value ??
        v?.oAuthSettings?.properties?.AzureActiveDirectoryResourceId,
      scopes: v?.oAuthSettings?.scopes,
    };
  }
  const fixture = {
    connectorId: cid,
    displayName: json.properties?.displayName ?? '',
    capturedFrom: 'https://api.powerapps.com/providers/Microsoft.PowerApps/apis (swagger)',
    proxyHost: sw.host ?? '',
    proxyBasePath: sw.basePath ?? '',
    securityDefinitions: sw.securityDefinitions ?? {},
    connectionAuth: authParams,
    operationCount: Object.keys(operations).length,
    operations,
  };
  writeFileSync(`src/connectors/fixtures/${cid}.ops.json`, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${cid}.ops.json  (${fixture.operationCount} ops)`);
}
process.exit(0);
