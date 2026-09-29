const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

const CANDIDATES = [
  'c9176288-690a-4629-9d0a-cd8c86a29f2a',
  'b3b7dc10-711b-4716-b153-444d88bdc4c2',
  '20be3a35-d915-4693-8bd1-239231ef522d',
  '36c8e585-4d87-41dc-b5b5-5029e7fb3400',
];

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  for (const sourceId of CANDIDATES) {
    const row = await db.collection('agentIRCache').findOne({ sourceId });
    if (!row) continue;
    console.log(row.ir.name, '| isManaged:', row.ir.isManaged, '| thinContent:', row.ir.thinContent, '| unmapped:', (row.ir.unmapped ?? []).slice(0, 3));
  }
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
