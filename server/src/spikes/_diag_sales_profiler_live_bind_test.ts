/**
 * Real test on the REAL, freshly re-extracted "Sales Profiler Agent" tool list (15 real
 * connector tools, live from Dataverse) — run every one through the real resolveOpIndex()
 * + bindOperation() to answer: do this agent's Microsoft-own connectors migrate without
 * failure today, with no new code?
 *
 * Run: npx tsx src/spikes/_diag_sales_profiler_live_bind_test.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { clientCredsToken } = await import('../auth/microsoft.js');
const { extractAgent } = await import('../services/dataverse.js');
const { resolveOpIndex } = await import('../connectors/captureOpIndex.js');
const { bindOperation } = await import('../connectors/operationBinding.js');

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

  console.log(`\n=== Sales Profiler Agent — ${connectorTools.length} real connector tool calls, live ===\n`);

  let bindableTotal = 0;
  let blockedTotal = 0;
  let msOwnBindable = 0;
  let msOwnBlocked = 0;
  let thirdPartyBindable = 0;
  let thirdPartyBlocked = 0;

  for (const [connectorId, opIds] of byConnector) {
    const registryEntry = await db.collection('connectors').findOne({ connectorId });
    const isMsOwn = registryEntry?.isMicrosoftOwnService === true;
    console.log(`--- ${connectorId} (${isMsOwn ? 'MS-own' : registryEntry ? 'third-party' : 'NOT IN REGISTRY'}) ---`);

    const index = await resolveOpIndex(connectorId, undefined);
    if (!index) {
      console.log(`  NO SPEC CAPTURED for this connector at all`);
      for (const opId of opIds) {
        blockedTotal++;
        if (isMsOwn) msOwnBlocked++; else thirdPartyBlocked++;
      }
      continue;
    }
    for (const opId of opIds) {
      const result = bindOperation(index, opId);
      const ok = result.status === 'bindable' || result.status === 'custom-tool';
      console.log(`  ${ok ? '✓' : '✗'} ${opId} — ${result.status.toUpperCase()}${!ok ? ': ' + (result as any).reason : ''}`);
      if (ok) {
        bindableTotal++;
        if (isMsOwn) msOwnBindable++; else thirdPartyBindable++;
      } else {
        blockedTotal++;
        if (isMsOwn) msOwnBlocked++; else thirdPartyBlocked++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total tool calls: ${connectorTools.length}`);
  console.log(`Bindable/migratable: ${bindableTotal}  (MS-own: ${msOwnBindable}, third-party: ${thirdPartyBindable})`);
  console.log(`Blocked: ${blockedTotal}  (MS-own: ${msOwnBlocked}, third-party: ${thirdPartyBlocked})`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
