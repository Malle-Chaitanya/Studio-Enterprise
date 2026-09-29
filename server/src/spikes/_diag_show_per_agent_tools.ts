/**
 * Proves per-agent tool usage is already captured — not the whole connector, just
 * whichever specific operations THIS agent's maker actually wired up. Samples a real
 * stagedAgents/agentIRCache row that has a connector tool and prints its agentTools.
 *
 * Run: npx tsx src/spikes/_diag_show_per_agent_tools.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const row = await db.collection('agentIRCache').findOne({ 'ir.agentTools.kind': 'connector' });
  if (!row) {
    console.log('No cached agent with a connector tool found in this DB.');
    await closeDb();
    return;
  }

  console.log('Agent:', row.ir.name, '| sourceId:', row.sourceId);
  console.log('\nagentTools (exactly what this agent wired up, nothing more):');
  for (const t of row.ir.agentTools ?? []) {
    console.log(`  - kind=${t.kind} connectorId=${t.connectorId ?? '-'} operationId=${t.operationId ?? '-'} name="${t.name}"`);
    if (t.inputs?.length) {
      console.log(`      pinned/model inputs: ${JSON.stringify(t.inputs)}`);
    }
  }

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
