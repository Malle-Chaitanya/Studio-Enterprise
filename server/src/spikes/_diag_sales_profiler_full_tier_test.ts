/**
 * Corrected version: checks BOTH tiers, the way production actually resolves a
 * connector tool — bindOperation() for an exact Tier-1 recipe, THEN falls back to
 * checking connectors/registry.ts's REGISTRY_BY_ID for a genuine Tier-2 generic tool
 * (what buildLiveConnectorSpecsDetailed actually builds "regardless of readiness" per
 * orchestrator.ts's own comment) before calling something truly blocked.
 *
 * Run: npx tsx src/spikes/_diag_sales_profiler_full_tier_test.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { clientCredsToken } = await import('../auth/microsoft.js');
const { extractAgent } = await import('../services/dataverse.js');
const { resolveOpIndex } = await import('../connectors/captureOpIndex.js');
const { bindOperation } = await import('../connectors/operationBinding.js');
const { REGISTRY_BY_ID } = await import('../connectors/registry.js');

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const BOTID = 'c9176288-690a-4629-9d0a-cd8c86a29f2a';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const token = await clientCredsToken(TENANT_ID, ENV_URL);
  const ir = await extractAgent(ENV_URL, token, { botid: BOTID, name: 'Sales Profiler Agent' });

  const connectorTools = (ir.agentTools ?? []).filter((t) => t.kind === 'connector' && t.connectorId && t.operationId);
  const byConnector = new Map<string, string[]>();
  for (const t of connectorTools) {
    if (!byConnector.has(t.connectorId!)) byConnector.set(t.connectorId!, []);
    byConnector.get(t.connectorId!)!.push(t.operationId!);
  }

  console.log(`\n=== Sales Profiler Agent — ${connectorTools.length} real connector tool calls, both tiers checked ===\n`);

  let tier1 = 0, tier2 = 0, tier3 = 0;

  for (const [connectorId, opIds] of byConnector) {
    const registryEntry = await db.collection('connectors').findOne({ connectorId });
    const isMsOwn = registryEntry?.isMicrosoftOwnService === true;
    const hasTier2 = REGISTRY_BY_ID.has(connectorId);
    console.log(`--- ${connectorId} (${isMsOwn ? 'MS-own' : registryEntry ? 'third-party' : 'not captured'}) — Tier-2 entry: ${hasTier2 ? 'yes' : 'no'} ---`);

    const index = await resolveOpIndex(connectorId, undefined);
    for (const opId of opIds) {
      const result = index ? bindOperation(index, opId) : null;
      if (result && (result.status === 'bindable' || result.status === 'custom-tool')) {
        console.log(`  ✓ ${opId} — TIER 1 (exact): ${result.status.toUpperCase()}`);
        tier1++;
      } else if (hasTier2) {
        console.log(`  ~ ${opId} — TIER 2 (generic fallback): works, model determines exact call`);
        tier2++;
      } else {
        console.log(`  ✗ ${opId} — TIER 3: not supported (no spec or no known base URL)`);
        tier3++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total tool calls: ${connectorTools.length}`);
  console.log(`Tier 1 (exact):            ${tier1}`);
  console.log(`Tier 2 (generic, working): ${tier2}`);
  console.log(`Tier 3 (not supported):    ${tier3}`);
  console.log(`Total that migrate in SOME working form (Tier 1 + Tier 2): ${tier1 + tier2} / ${connectorTools.length}`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
