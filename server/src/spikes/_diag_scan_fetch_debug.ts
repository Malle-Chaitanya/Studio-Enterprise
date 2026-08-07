/** Is the knowledge-source query returning rows at all? Mirrors the scan's own filter.
 *  npx tsx src/spikes/_diag_scan_fetch_debug.ts <envUrl> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';
const ENV = process.argv[2] ?? 'https://orga243378d.crm.dynamics.com';
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const bots = await listBots(ENV, token);
const ids = bots.slice(0, 40).map((b) => `'${b.botid}'`).join(',');
const base = ENV.replace(/\/$/, '');
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

for (const [label, filter, select] of [
  ['scan filter + new select', `componenttype eq 16 and Microsoft.Dynamics.CRM.In(PropertyName='parentbotid',PropertyValues=[${ids}])`, 'botcomponentid,name,data,content,description,schemaname,parentbotid'],
  ['scan filter, no select', `componenttype eq 16 and Microsoft.Dynamics.CRM.In(PropertyName='parentbotid',PropertyValues=[${ids}])`, ''],
  ['plain componenttype 16', 'componenttype eq 16', ''],
] as const) {
  const url = `${base}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(filter)}${select ? `&$select=${select}` : ''}&$top=50`;
  const r = await fetch(url, { headers: h });
  const t = await r.text();
  if (!r.ok) { console.log(`[${r.status}] ${label}: ${t.replace(/\s+/g, ' ').slice(0, 220)}`); continue; }
  const j = JSON.parse(t) as { value?: Array<Record<string, any>> };
  const rows = j.value ?? [];
  console.log(`[200] ${label}: ${rows.length} row(s)`);
  if (rows[0]) console.log(`      keys: ${Object.keys(rows[0]).filter((k) => !k.startsWith('@')).join(', ').slice(0, 160)}`);
}
process.exit(0);
