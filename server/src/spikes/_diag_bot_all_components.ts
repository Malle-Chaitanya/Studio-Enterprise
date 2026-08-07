/** Every botcomponent for an agent, no type filter — and the bot record itself.
 *  Used when an agent looks empty but the Copilot Studio UI shows knowledge sources.
 *  npx tsx src/spikes/_diag_bot_all_components.ts <envUrl> <botId> */
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
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

// 1. The bot record — is it active, and which solution does it live in?
const br = await fetch(`${base}/api/data/v9.2/bots(${BOT})`, { headers: h });
const bj = await br.json() as Record<string, any>;
console.log(`bot [${br.status}]: ${bj.name}`);
console.log(`  statecode=${bj.statecode} statuscode=${bj.statuscode} ismanaged=${bj.ismanaged} schemaname=${bj.schemaname}`);
console.log(`  authenticationmode=${bj.authenticationmode} publishedon=${bj.publishedon ?? '-'}`);

// 2. Components by BOTH lookup spellings — the filter field is the usual suspect.
for (const filter of [`_parentbotid_value eq ${BOT}`, `parentbotid/botid eq ${BOT}`]) {
  const r = await fetch(`${base}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(filter)}&$top=100`, { headers: h });
  if (!r.ok) { console.log(`\n[${r.status}] filter "${filter}": ${(await r.text()).replace(/\s+/g,' ').slice(0,140)}`); continue; }
  const rows = ((await r.json()) as { value?: Array<Record<string, any>> }).value ?? [];
  console.log(`\nfilter "${filter}": ${rows.length} component(s)`);
  const byType = new Map<number, string[]>();
  for (const c of rows) {
    const list = byType.get(c.componenttype) ?? [];
    list.push(c.name);
    byType.set(c.componenttype, list);
  }
  for (const [t, names] of [...byType].sort((a, b) => a[0] - b[0])) {
    console.log(`  type ${t}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` (+${names.length - 6})` : ''}`);
  }
}
process.exit(0);
