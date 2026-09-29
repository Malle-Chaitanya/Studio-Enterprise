/**
 * Real test: for the "Sales Profiler Agent", isolate ONLY its Microsoft-own-service
 * connector tool calls (per db/repos/connectorRegistry.ts's isMicrosoftOwnService flag)
 * and run each through the real resolveOpIndex() + bindOperation() functions to see
 * whether they'd genuinely migrate without failure, today, with no new code.
 *
 * Run: npx tsx src/spikes/_diag_sales_profiler_ms_only.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { resolveOpIndex } = await import('../connectors/captureOpIndex.js');
const { bindOperation } = await import('../connectors/operationBinding.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const row = await db.collection('agentIRCache').findOne({ sourceId: 'c9176288-690a-4629-9d0a-cd8c86a29f2a' });
  if (!row) throw new Error('agent not found');
  console.log(`Agent: ${row.ir.name}\n`);

  const connectorTools = (row.ir.agentTools ?? []).filter((t: any) => t.kind === 'connector' && t.connectorId && t.operationId);
  const byConnector = new Map<string, string[]>();
  for (const t of connectorTools) {
    if (!byConnector.has(t.connectorId)) byConnector.set(t.connectorId, []);
    byConnector.get(t.connectorId)!.push(t.operationId);
  }

  console.log('All connectors this agent uses:', [...byConnector.keys()].join(', '), '\n');

  let msOwnTotal = 0;
  let msOwnBindable = 0;
  let msOwnBlocked = 0;
  let thirdPartyCount = 0;

  for (const [connectorId, opIds] of byConnector) {
    const registryEntry = await db.collection('connectors').findOne({ connectorId });
    const isMsOwn = registryEntry?.isMicrosoftOwnService === true;
    if (!isMsOwn) {
      thirdPartyCount += opIds.length;
      console.log(`=== ${connectorId} — SKIPPED (not Microsoft-own; ${registryEntry ? 'third-party' : 'not in registry'}) ===\n`);
      continue;
    }

    console.log(`=== ${connectorId} (Microsoft-own) — ${opIds.length} tool call(s) this agent uses ===`);
    const index = await resolveOpIndex(connectorId, undefined);
    if (!index) {
      console.log('  NO INDEX FOUND');
      msOwnTotal += opIds.length;
      msOwnBlocked += opIds.length;
      continue;
    }
    for (const opId of opIds) {
      msOwnTotal++;
      const result = bindOperation(index, opId);
      if (result.status === 'bindable' || result.status === 'custom-tool') {
        console.log(`  ✓ ${opId} — ${result.status.toUpperCase()}`);
        msOwnBindable++;
      } else {
        console.log(`  ✗ ${opId} — ${result.status.toUpperCase()}: ${result.reason}`);
        msOwnBlocked++;
      }
    }
    console.log('');
  }

  console.log('=== Summary (Microsoft-own connectors only) ===');
  console.log(`Total MS-own tool calls: ${msOwnTotal}`);
  console.log(`Bindable/migratable: ${msOwnBindable}`);
  console.log(`Blocked: ${msOwnBlocked}`);
  console.log(`(Third-party tool calls on this agent, not counted above: ${thirdPartyCount})`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
