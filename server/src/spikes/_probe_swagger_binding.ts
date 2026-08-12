/**
 * Binding question (plan step 3b): a swagger path is `/{connectionId}/...`, which is the
 * Power Platform PROXY's address, not the vendor's. A migrated Gemini agent has no Power
 * Platform connection, so it cannot call that. To reproduce the call we need to know what
 * the proxy would have called on our behalf.
 *
 * This dumps, per connector, the parts of the swagger that answer it:
 *   host / basePath / schemes        - where the proxy lives
 *   securityDefinitions              - what auth the vendor expects (oauth2 flow, apiKey, basic)
 *   x-ms-connector-metadata          - publisher/website, useful for the real base URL
 *   the used operations' parameters  - what the tool signature must accept
 *
 * The hypothesis being tested: for several connectors the segment AFTER {connectionId} is
 * literally the vendor's own path (Confluence `/ex/confluence/{cloudId}/wiki/api/v2/pages`,
 * HubSpot `/crm/v3/objects/companies`), in which case host substitution is the whole
 * transform. Where it is a Microsoft abstraction instead (Google Drive
 * `/datasets/default/files/{id}`) that connector needs a hand-written mapping and must be
 * reported as such rather than guessed.
 *
 * Read-only. npx tsx src/spikes/_probe_swagger_binding.ts [envUrl]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const ENV = process.argv[2] ?? 'https://org32322095.crm.dynamics.com';
// The connectors this tenant actually uses (ledger 1.10), plus the two SharePoint/Teams
// ids that dominate the other environment.
const IDS = [
  'shared_confluence',
  'shared_jira',
  'shared_commondataserviceforapps',
  'shared_hubspotcrm',
  'shared_hubspotsettingsv2',
  'shared_powerplatformadminv2',
  'shared_googledrive',
  'shared_sharepointonline',
];
const USED: Record<string, string[]> = {
  shared_confluence: ['GetPages'],
  shared_jira: ['mcp_JiraIssueManagement'],
  shared_commondataserviceforapps: ['ListRecordsWithOrganization', 'CreateRecordWithOrganization'],
  shared_hubspotcrm: ['CompaniesList'],
  shared_hubspotsettingsv2: ['GetTheDailyApiUsageAndLimitsForAHubspotAccount'],
  shared_powerplatformadminv2: ['ListEnvironmentsForUser'],
  shared_googledrive: ['GetFileContent', 'ListFolder'],
  shared_sharepointonline: ['HttpRequest'],
};

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

for (const cid of IDS) {
  const url =
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${cid}` +
    `?api-version=2016-11-01&$filter=environment eq '${env.id}'&$expand=swagger`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${paToken}` } });
  if (!res.ok) {
    console.log(`\n### ${cid} - ${res.status}`);
    continue;
  }
  const json = (await res.json()) as any;
  const sw = json.properties?.swagger ?? {};
  console.log(`\n### ${cid} - ${json.properties?.displayName ?? ''}`);
  console.log(`  host      ${sw.host ?? '-'}   basePath ${sw.basePath ?? '-'}   schemes ${(sw.schemes ?? []).join(',')}`);
  console.log(`  security  ${JSON.stringify(sw.securityDefinitions ?? {}).slice(0, 400)}`);
  const meta = json.properties?.connectionParameters ?? {};
  console.log(`  connParams ${JSON.stringify(meta).slice(0, 500)}`);
  console.log(`  capabilities ${JSON.stringify(json.properties?.capabilities ?? [])}`);
  for (const [p, verbs] of Object.entries<any>(sw.paths ?? {})) {
    for (const [verb, o] of Object.entries<any>(verbs ?? {})) {
      if (!o?.operationId || !(USED[cid] ?? []).includes(o.operationId)) continue;
      console.log(`  op ${o.operationId}: ${verb.toUpperCase()} ${p}`);
      for (const prm of o.parameters ?? []) {
        const req = prm.required ? 'required' : 'optional';
        const vis = prm['x-ms-visibility'] ? ` vis=${prm['x-ms-visibility']}` : '';
        console.log(`      - ${prm.name} in=${prm.in} ${req} type=${prm.type ?? prm.schema?.type ?? '?'}${vis}`);
      }
    }
  }
}
process.exit(0);
