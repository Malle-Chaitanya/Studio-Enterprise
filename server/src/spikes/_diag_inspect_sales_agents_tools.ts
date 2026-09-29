/**
 * Inspects the actual agentTools list of a few candidate "sales" agents to find one
 * that genuinely uses connector tool calls, before running the MS-own-connector test.
 *
 * Run: npx tsx src/spikes/_diag_inspect_sales_agents_tools.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

const CANDIDATES = [
  'c9176288-690a-4629-9d0a-cd8c86a29f2a', // Sales Profiler Agent
  'b3b7dc10-711b-4716-b153-444d88bdc4c2', // Sales Opportunity Agent
  '20be3a35-d915-4693-8bd1-239231ef522d', // D365 Sales Agent - Research
  '36c8e585-4d87-41dc-b5b5-5029e7fb3400', // Copilot in Dynamics 365 Sales
];

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  for (const sourceId of CANDIDATES) {
    const row = await db.collection('agentIRCache').findOne({ sourceId });
    if (!row) {
      console.log(`${sourceId}: NOT FOUND\n`);
      continue;
    }
    const tools = row.ir.agentTools ?? [];
    const kinds = tools.reduce((acc: Record<string, number>, t: any) => {
      acc[t.kind] = (acc[t.kind] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`${row.ir.name} (${sourceId})`);
    console.log(`  total tools: ${tools.length}, by kind: ${JSON.stringify(kinds)}`);
    const connectorIds = new Set(tools.filter((t: any) => t.kind === 'connector').map((t: any) => t.connectorId));
    console.log(`  connectors used: ${[...connectorIds].join(', ') || '(none)'}\n`);
  }

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
