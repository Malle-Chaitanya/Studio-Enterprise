/**
 * Find which real captured connector actually owns a "Get Apps As Administrator"-shaped
 * operation, and what its real path/host looks like — rather than assume it belongs to
 * shared_powerplatformforadmins (which turned out to have no apps-listing operation at all).
 *
 * Run: npx tsx src/spikes/_diag_find_getappsasadmin.ts
 */
const { getDb, connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb();

  const ops = await db
    .collection('connectorOperations')
    .find({ $or: [
      { operationId: /apps.*admin/i },
      { summary: /apps.*admin/i },
    ] } as never)
    .toArray();

  console.log(`${ops.length} matching operations found:\n`);
  for (const op of ops) {
    const o = op as any;
    console.log('connectorId:', o.connectorId, '| operationId:', o.operationId, '| summary:', o.summary);
    console.log('  method:', o.method, 'path:', o.path);
    console.log('  full doc:', JSON.stringify(o).slice(0, 800));
    console.log('');
  }

  // Also: which real agent tool in Sales Profiler Agent is this bound to? Find the agent and
  // print its actual connectorId + operationId for the "Get Apps As Administrator" tool.
  const agent = await db.collection('agentIRCache').findOne({
    sourceId: 'c9176288-690a-4629-9d0a-cd8c86a29f2a',
  } as never);
  if (agent) {
    const tools = ((agent as any).ir?.agentTools ?? []).filter((t: any) =>
      /app.*admin|admin.*app/i.test(t.displayName ?? t.name ?? t.operationId ?? ''),
    );
    console.log('Sales Profiler Agent tools matching "app...admin":', JSON.stringify(tools, null, 2));
  } else {
    console.log('Sales Profiler Agent not found by that sourceId');
  }
}

main()
  .then(() => closeDb())
  .catch((e) => {
    console.error('FAILED:', e);
  })
  .finally(() => process.exit(0));
