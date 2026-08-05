import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const rows = await db.collection('knowledgeConnectors').find({}).toArray();
  console.log(`knowledgeConnectors: ${rows.length} row(s)`);
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
