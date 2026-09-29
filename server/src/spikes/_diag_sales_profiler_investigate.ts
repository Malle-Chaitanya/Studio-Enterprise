/**
 * The real Copilot Studio UI shows "Sales Profiler Agent" has 14+ real connector tools
 * (screenshot evidence), but our cached agentIRCache row for it showed ZERO. Find out why:
 * wrong row matched, stale capture, or a real extraction bug dropping tools for managed
 * solution agents.
 *
 * Run: npx tsx src/spikes/_diag_sales_profiler_investigate.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  console.log('=== ALL agentIRCache rows named "Sales Profiler Agent" ===');
  const rows = await db.collection('agentIRCache').find({ 'ir.name': 'Sales Profiler Agent' }).toArray();
  console.log(`Found ${rows.length} row(s)\n`);
  for (const r of rows) {
    console.log('sourceId:', r.sourceId);
    console.log('appUserId:', r.appUserId, '| envUrl:', r.envUrl, '| tenantId:', r.tenantId);
    console.log('extractedAt:', r.extractedAt);
    console.log('ir.isManaged:', r.ir.isManaged, '| ir.thinContent:', r.ir.thinContent);
    console.log('ir.schemaName:', r.ir.schemaName);
    console.log('agentTools length:', (r.ir.agentTools ?? []).length);
    console.log('ir.unmapped:', r.ir.unmapped);
    console.log('---');
  }

  console.log('\n=== stagedAgents rows named "Sales Profiler Agent" ===');
  const staged = await db.collection('stagedAgents').find({ name: 'Sales Profiler Agent' }).toArray();
  console.log(`Found ${staged.length} row(s)`);
  for (const s of staged) {
    console.log('sourceId:', s.sourceId, '| status:', s.status, '| toolCount(if any field):', s.toolCount);
  }

  console.log('\n=== rawAgents rows named "Sales Profiler Agent" (if raw capture was on) ===');
  const raw = await db.collection('rawAgents').find({ name: 'Sales Profiler Agent' }).toArray().catch(() => []);
  console.log(`Found ${raw.length} row(s)`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
