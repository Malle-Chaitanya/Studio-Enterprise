/**
 * Populates the clean, normalized connector registry (connectors + connectorOperations)
 * with the genuine Microsoft-OWN-SERVICE connectors relevant to Copilot Studio agents —
 * deduplicated (e.g. shared_commondataservice dropped in favor of
 * shared_commondataserviceforapps; shared_servicebus-1 dropped as a duplicate of
 * shared_servicebus). Deliberately excludes connectors merely PUBLISHED by Microsoft for a
 * third-party service (Salesforce, Zendesk, Slack, etc.) — those behave like Dropbox, not
 * like Teams/SharePoint, and don't belong in this specific bucket.
 *
 * Run: npx tsx src/spikes/_prep_populate_ms_connector_registry.ts
 */
import { connectDb, closeDb } from '../db/core.js';
import { captureOpIndex } from '../connectors/captureOpIndex.js';
import { putConnector, putConnectorOperations, toRegistryRecords } from '../db/repos/connectorRegistry.js';
import { config } from '../config.js';

const CTX = {
  tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e',
  environmentId: '7f9f87cc-464e-e470-95bb-363b7f227200',
  scope: '6a5dfdff7cf05623332758b7',
};

// [connectorId, category] — real, distinct, genuinely-Microsoft-owned services only.
const MS_OWN_CONNECTORS: Array<[string, string]> = [
  ['shared_teams', 'communication'],
  ['shared_sharepointonline', 'content'],
  ['shared_onedriveforbusiness', 'content'],
  ['shared_office365', 'communication'],
  ['shared_office365users', 'communication'],
  ['shared_office365groups', 'communication'],
  ['shared_excelonlinebusiness', 'productivity'],
  ['shared_wordonlinebusiness', 'productivity'],
  ['shared_onenote', 'productivity'],
  ['shared_commondataserviceforapps', 'data'],
  ['shared_planner', 'productivity'],
  ['shared_microsoftforms', 'productivity'],
  ['shared_todo', 'productivity'],
  ['shared_microsoftcopilotstudio', 'ai'],
  ['shared_powerbi', 'data'],
  ['shared_azuread', 'identity'],
  ['shared_visualstudioteamservices', 'devops'],
  ['shared_dynamicssmbsaas', 'business-apps'],
  ['shared_customerinsights', 'business-apps'],
  ['shared_assistantstudiov2', 'business-apps'],
  ['shared_microsoftformspro', 'business-apps'],
  ['shared_yammer', 'communication'],
  ['shared_microsoftloop', 'productivity'],
  ['shared_agentnode', 'ai'],
  ['shared_conversionservice', 'content'],
];

async function main() {
  await connectDb(config.CSGE_DB);

  let ok = 0;
  const failed: string[] = [];

  for (const [connectorId, category] of MS_OWN_CONNECTORS) {
    process.stdout.write(`Capturing ${connectorId}... `);
    try {
      const index = await captureOpIndex(connectorId, CTX);
      if (!index) {
        console.log('no index returned (not installed in this environment or capture failed)');
        failed.push(connectorId);
        continue;
      }
      const { connector, operations } = toRegistryRecords(connectorId, 'Microsoft', true, category, index);
      await putConnector(connector);
      await putConnectorOperations(connectorId, operations);
      console.log(`OK — ${operations.length} operations`);
      ok++;
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
      failed.push(connectorId);
    }
  }

  console.log(`\nDone. ${ok}/${MS_OWN_CONNECTORS.length} connectors captured and written.`);
  if (failed.length) console.log(`Not captured (no fixture/environment data): ${failed.join(', ')}`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
