import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const rows = await db.collection('migrationResults').find({
    fidelity: { $elemMatch: { detail: { $regex: 'ADK', $options: 'i' } } },
  }).toArray();
  console.log(`Found ${rows.length} migrationResults with an ADK-related fidelity note`);
  for (const r of rows as any[]) {
    console.log('---');
    console.log('name:', r.name, 'geminiAgentId:', r.geminiAgentId, 'created:', r.created, 'deployed:', r.deployed);
    for (const f of r.fidelity) {
      if (/ADK|knowledge:/i.test(f.component) || /ADK/i.test(f.detail)) {
        console.log(` [${f.status}] ${f.component}: ${f.detail}`);
      }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
