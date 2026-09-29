/**
 * Structural verification of the new registry.ts entries: confirms each resolves,
 * confirms the ServiceNow id fix is genuinely reachable under Microsoft's real
 * connector id, and confirms buildLiveConnectorSpecsDetailed produces a spec for each
 * (proving the Tier-2 fallback wiring actually activates for them) — without needing
 * real customer credentials, since that function only needs the registry entry to exist.
 *
 * Run: npx tsx src/spikes/_diag_verify_new_registry_entries.ts
 */
const { REGISTRY_BY_ID } = await import('../connectors/registry.js');
const { buildLiveConnectorSpecsDetailed } = await import('../services/connectorToolBuilder.js');

const NEW_IDS = [
  'shared_service-now', 'shared_pagerduty', 'shared_todoist', 'shared_bitbucket',
  'shared_vimeo', 'shared_bitly', 'shared_typeform', 'shared_surveymonkey',
  'shared_pinterest', 'shared_freshservice',
];

function main() {
  for (const id of NEW_IDS) {
    const def = REGISTRY_BY_ID.get(id);
    console.log(id, '->', def ? `OK (${def.name}, base=${def.baseUrlTemplate})` : 'MISSING');
  }

  console.log('\n=== buildLiveConnectorSpecsDetailed for all 10 (no real secrets present) ===');
  const { specs, unsupported } = buildLiveConnectorSpecsDetailed(NEW_IDS, { ownerScope: 'diag-scope' });
  console.log('unsupported (should be empty):', unsupported);
  console.log('specs produced:', specs.length, '/', NEW_IDS.length);
  for (const s of specs) console.log(' ', s.id, '->', s.baseUrlTemplate);
}

main();
