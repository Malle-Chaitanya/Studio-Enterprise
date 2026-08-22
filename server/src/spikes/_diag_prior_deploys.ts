/** Which of the recommended agents ALREADY have a deployment record? Reuse keys on our own
 *  record (appUserId+envUrl+sourceId+dest), NOT on the Gemini display name — so the console's
 *  duplicate names say nothing about what will be skipped. Ask the record instead. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const IDS: Record<string, string> = {
  'Enterprise Migration Knowledge': 'bdf9b817',
  'Teams Coordinator': '9b97b5fc',
  'Email Manager': '45d6b647',
  'HubSpot Agent': '442c7099',
  'Confluence Knowledge Assistant': '87aaf041',
};
const colls = (await db.listCollections().toArray()).map((c) => c.name);
const target = colls.filter((c) => /deploy|snapshot/i.test(c));
console.log('deployment-ish collections:', target.join(', ') || '(none)');
for (const c of target) {
  const rows = (await db.collection(c).find({}).toArray()) as Array<Record<string, unknown>>;
  console.log(`\n=== ${c} (${rows.length}) ===`);
  for (const [name, pre] of Object.entries(IDS)) {
    const hits = rows.filter((r) => JSON.stringify(r).includes(pre));
    console.log(`  ${name.padEnd(34)} ${hits.length ? `HAS RECORD (${hits.length}) users=${[...new Set(hits.map((h) => String(h.appUserId)))].join(',')}` : 'none'}`);
  }
}
process.exit(0);
