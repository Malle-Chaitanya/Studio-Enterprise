/**
 * Real check: for a handful of connectors marked "Publisher: Microsoft", what is their
 * ACTUAL backend service URL — Microsoft's own domain, or a genuinely third-party one?
 * Uses the same admin API field customConnectorInventory.ts already reads for custom
 * connectors (`backendService.serviceUrl`), to see if it's populated for standard
 * connectors too — real evidence, not a guess from memory.
 *
 * Run: npx tsx src/spikes/_diag_connector_backend_hosts.ts
 */
import { clientCredsToken } from '../auth/microsoft.js';

const POWERAPPS_AUDIENCE = 'https://service.powerapps.com';
const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENVIRONMENT_ID = '7f9f87cc-464e-e470-95bb-363b7f227200';

const TEST_IDS = [
  'shared_zendesk',
  'shared_dropbox',
  'shared_salesforce',
  'shared_slack',
  'shared_github',
  'shared_teams',
  'shared_sharepointonline',
  'shared_excelonlinebusiness',
];

async function main() {
  const token = await clientCredsToken(TENANT_ID, POWERAPPS_AUDIENCE);

  for (const id of TEST_IDS) {
    const url =
      `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${encodeURIComponent(id)}` +
      `?api-version=2016-11-01&$filter=${encodeURIComponent(`environment eq '${ENVIRONMENT_ID}'`)}`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        console.log(`${id}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as {
        properties?: { displayName?: string; publisher?: string; backendService?: { serviceUrl?: string } };
      };
      const p = json.properties ?? {};
      console.log(
        `${id.padEnd(28)} | ${(p.displayName ?? '').padEnd(20)} | publisher=${(p.publisher ?? '').padEnd(12)} | backend=${p.backendService?.serviceUrl ?? '(none returned)'}`,
      );
    } catch (e) {
      console.log(`${id}: ERROR ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
