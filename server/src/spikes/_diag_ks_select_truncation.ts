/** Does $select truncate botcomponent `data`? The knowledge-connector scan uses
 *  $select and finds nothing; a full fetch of the same rows contains "Confluence".
 *  npx tsx src/spikes/_diag_ks_select_truncation.ts <envUrl> <botId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';
const ENV = process.argv[2]!, BOT = process.argv[3]!;
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const base = ENV.replace(/\/$/, '');
const filter = encodeURIComponent(`componenttype eq 16 and _parentbotid_value eq ${BOT}`);
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

for (const [label, url] of [
  ['WITH $select (what the scanner does)', `${base}/api/data/v9.2/botcomponents?$filter=${filter}&$select=botcomponentid,name,data,content,parentbotid&$top=5`],
  ['WITHOUT $select', `${base}/api/data/v9.2/botcomponents?$filter=${filter}&$top=5`],
] as const) {
  const r = await fetch(url, { headers: h });
  const j = await r.json() as { value?: Array<Record<string, any>> };
  console.log(`\n=== ${label} [${r.status}] ===`);
  for (const c of j.value ?? []) {
    console.log(`  ${c.name}`);
    for (const f of ['data', 'content', 'description', 'schemaname']) {
      const v = c[f];
      if (typeof v === 'string' && v.length) {
        console.log(`    ${f.padEnd(12)} len=${String(v.length).padEnd(5)} hasConfluence=${/onfluence/i.test(v)}`);
      }
    }
  }
}
process.exit(0);
