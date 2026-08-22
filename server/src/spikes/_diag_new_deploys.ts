/** What did the run just record? Print the newest deployment rows with whatever field actually
 *  holds the Reasoning Engine id, since asking an agent a question needs the RE id, not the
 *  agent id, and the two are easy to confuse. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = (await getDb().collection('adkDeployments').find({}).sort({ _id: -1 }).limit(4).toArray()) as Array<Record<string, unknown>>;
for (const r of rows) {
  console.log(`--- ${String(r.name ?? r.displayName ?? '?')}  source=${String(r.sourceId ?? '?').slice(0, 8)} user=${String(r.appUserId)}`);
  for (const [k, v] of Object.entries(r)) {
    if (k === '_id') continue;
    const s = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v);
    console.log(`    ${k.padEnd(22)} ${s}`);
  }
}
process.exit(0);
