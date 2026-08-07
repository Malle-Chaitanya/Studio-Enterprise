/** Dump knowledge-source botcomponents for an agent, to see what the scanner sees.
 *  npx tsx src/spikes/_diag_ks_components.ts <envUrl> <botId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';
const ENV = process.argv[2]!;
const BOT = process.argv[3]!;
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const base = ENV.replace(/\/$/, '');
for (const ct of [16, 15, 17]) {
  const filter = `componenttype eq ${ct} and _parentbotid_value eq ${BOT}`;
  const url = `${base}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(filter)}&$select=botcomponentid,name,data,content,componenttype&$top=20`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const t = await r.text();
  if (!r.ok) { console.log(`componenttype ${ct}: ${r.status} ${t.replace(/\s+/g,' ').slice(0,150)}`); continue; }
  const j = JSON.parse(t) as { value?: Array<Record<string, any>> };
  console.log(`\ncomponenttype ${ct}: ${(j.value ?? []).length} component(s)`);
  for (const c of (j.value ?? []).slice(0, 6)) {
    const raw = (c.data || c.content || '');
    console.log(`  - ${c.name}`);
    console.log(`    mentions confluence: ${/confluence/i.test(raw)}  len=${raw.length}`);
    console.log(`    head: ${String(raw).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}
process.exit(0);
