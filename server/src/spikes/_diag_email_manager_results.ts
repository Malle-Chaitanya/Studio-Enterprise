import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const rows = await db.collection('migrationResults')
  .find({ name: /Email Manager/i }).sort({ updatedAt: -1 }).limit(6).toArray();
for (const x of rows) {
  const m = x as Record<string, unknown>;
  console.log(`${String(m.updatedAt)}  ${String(m.name)}  created=${m.created} deployed=${m.deployed} shared=${m.shared} error=${String(m.error ?? '-')}`);
}
process.exit(0);
