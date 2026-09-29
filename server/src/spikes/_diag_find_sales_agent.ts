/**
 * Find the real cached agent whose name matches "sales" / "profile" to test its
 * Microsoft-own connectors end to end.
 *
 * Run: npx tsx src/spikes/_diag_find_sales_agent.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const rows = await db.collection('agentIRCache').find({ 'ir.name': { $regex: 'sales|profile', $options: 'i' } }).project({ sourceId: 1, 'ir.name': 1 }).toArray();
  console.log(`Found ${rows.length} matching agent(s):`);
  for (const r of rows) console.log(`  sourceId=${r.sourceId}  name="${r.ir.name}"`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
