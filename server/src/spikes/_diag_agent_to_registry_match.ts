/**
 * The real end-to-end check: for a real agent's real agentTools (what it actually
 * wired up in Copilot Studio), does each connector operation (a) match something in
 * our DB registry, and (b) actually bind into a callable tool via the real
 * resolveOpIndex() + bindOperation() functions — or does it fail, and why?
 *
 * Run: npx tsx src/spikes/_diag_agent_to_registry_match.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { resolveOpIndex } = await import('../connectors/captureOpIndex.js');
const { bindOperation } = await import('../connectors/operationBinding.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const row = await db.collection('agentIRCache').findOne({
    sourceId: 'bdf9b817-9b90-f111-b8da-0022480b1f83',
    'ir.name': 'Migrate Advisor',
  });
  if (!row) throw new Error('agent not found');

  console.log(`Agent: ${row.ir.name}\n`);

  const connectorTools = (row.ir.agentTools ?? []).filter((t: any) => t.kind === 'connector' && t.connectorId && t.operationId);
  const byConnector = new Map<string, string[]>();
  for (const t of connectorTools) {
    if (!byConnector.has(t.connectorId)) byConnector.set(t.connectorId, []);
    byConnector.get(t.connectorId)!.push(t.operationId);
  }

  let totalBindable = 0;
  let totalBlocked = 0;

  for (const [connectorId, opIds] of byConnector) {
    console.log(`=== ${connectorId} (${opIds.length} tool call(s) this agent uses) ===`);
    // No CaptureContext (undefined) — simulates a customer whose own environment we are
    // NOT re-hitting right now, so this resolves purely from the DB registry / fixture,
    // exactly the path a NEW customer with this same connector would take on first match.
    const index = await resolveOpIndex(connectorId, undefined);
    if (!index) {
      console.log(`  NO INDEX FOUND — this connector has no captured spec anywhere (registry or fixture).`);
      totalBlocked += opIds.length;
      continue;
    }
    console.log(`  index found: ${index.operationCount} total operations known for this connector`);
    for (const opId of opIds) {
      const result = bindOperation(index, opId);
      if (result.status === 'bindable') {
        console.log(`  ✓ ${opId} — BINDABLE: ${result.operation.method} ${result.operation.urlTemplate}`);
        totalBindable++;
      } else if (result.status === 'custom-tool') {
        console.log(`  ✓ ${opId} — CUSTOM-TOOL: ${result.reason}`);
        totalBindable++;
      } else {
        console.log(`  ✗ ${opId} — ${result.status.toUpperCase()}: ${result.reason}`);
        totalBlocked++;
      }
    }
    console.log('');
  }

  console.log(`=== Summary ===`);
  console.log(`Bindable/migratable tool calls: ${totalBindable}`);
  console.log(`Blocked tool calls: ${totalBlocked}`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
