/**
 * What backend host does each MCP-bound CUSTOM connector actually point at?
 *
 * `McpBindingIR.serverUrl` is never in the Copilot payload, so the only lead we have is the
 * custom connector's own published definition. This asks the Power Apps admin API for it.
 *
 *   npx tsx src/spikes/_probe_mcp_hosts.ts
 *
 * Read-only.
 */
import { listCustomConnectors } from '../connectors/customConnectorInventory.js';
import { config } from '../config.js';

const TENANT = process.env.MS_TENANT_ID || config.MS_TENANT_ID || 'common';
const ENV_ID = process.env.PA_ENV_ID || '';

if (!ENV_ID) {
  console.log(
    'Set PA_ENV_ID to the Power Platform environment id (the GUID form, e.g.\n' +
      '  PA_ENV_ID=Default-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\n' +
      'Find it in the Power Platform admin centre, or from the environments cache.',
  );
  process.exit(1);
}

const list = await listCustomConnectors(TENANT, ENV_ID);
if (!list) {
  console.log('custom connector listing unavailable (admin API refused or env id wrong)');
  process.exit(1);
}

console.log(`${list.length} custom connector(s) in ${ENV_ID}\n`);
for (const c of list) {
  const j = c as unknown as Record<string, unknown>;
  const interesting = Object.entries(j)
    .filter(([k]) => /id|name|host|url|backend|auth/i.test(k))
    .map(([k, v]) => `${k}=${String(v).slice(0, 90)}`)
    .join('  ');
  console.log(`  ${interesting}`);
}
process.exit(0);
