/**
 * Complete, factual picture for Sales Profiler Agent: every connector tool, its real
 * connectionAuthMode as Copilot Studio captured it (invoker = tied to one person's sign-in;
 * anything else = app-level), and whether our registry actually has a live Tier-2 tool for it
 * at all. No inference, no guessing — straight from the real captured agent IR.
 *
 * Run: npx tsx src/spikes/_diag_sales_profiler_full_authmode_scan.ts
 */
const { getDb, connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { REGISTRY_BY_ID } = await import('../connectors/registry.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb();

  const agent = await db.collection('agentIRCache').findOne({
    sourceId: 'c9176288-690a-4629-9d0a-cd8c86a29f2a',
  } as never);
  if (!agent) throw new Error('agent not found');

  const tools = ((agent as any).ir?.agentTools ?? []).filter((t: any) => t.kind === 'connector');

  const byConnector = new Map<string, { authModes: Set<string>; ops: string[] }>();
  for (const t of tools) {
    const key = t.connectorId ?? 'unknown';
    if (!byConnector.has(key)) byConnector.set(key, { authModes: new Set(), ops: [] });
    const entry = byConnector.get(key)!;
    entry.authModes.add(t.connectionAuthMode ?? '(none)');
    entry.ops.push(t.name ?? t.operationId ?? '?');
  }

  console.log(`Sales Profiler Agent — ${tools.length} connector tools across ${byConnector.size} connectors\n`);
  console.log('connectorId'.padEnd(35), 'authMode(s)'.padEnd(20), 'has Tier-2 tool?', '  ops');
  console.log('-'.repeat(120));
  for (const [connectorId, info] of [...byConnector.entries()].sort()) {
    const def = REGISTRY_BY_ID.get(connectorId);
    const hasLive = def ? 'YES' : 'NO (no registry entry)';
    console.log(
      connectorId.padEnd(35),
      [...info.authModes].join(',').padEnd(20),
      hasLive.padEnd(24),
      info.ops.join(' | '),
    );
  }
}

main()
  .then(() => closeDb())
  .catch((e) => {
    console.error('FAILED:', e);
  })
  .finally(() => process.exit(0));
