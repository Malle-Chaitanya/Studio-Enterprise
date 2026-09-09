/** Live probe #2: Deal Desk returned 0 flow-tools with the invokeflowtaskaction/flowId
 *  pattern from _diag_dealdesk_flow_probe.ts, despite the UI showing 4 Flow-type tools.
 *  Dump the raw componenttype histogram and every component whose blob mentions "flow"
 *  (case-insensitive) so we can see the actual shape instead of guessing. Read-only.
 *  npx tsx src/spikes/_diag_dealdesk_raw_components.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s || !s.tenantId || !s.dvOrgUrl) {
  console.log('NO_USABLE_SESSION');
  process.exit(0);
}
const base = s.dvOrgUrl.replace(/\/$/, '');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

const botRes = await fetch(`${base}/api/data/v9.2/bots?$filter=${encodeURIComponent("name eq 'Deal Desk'")}&$select=botid`, { headers: h });
const botJson = (await botRes.json()) as { value?: Array<{ botid: string }> };
const botId = botJson.value?.[0]?.botid;
if (!botId) {
  console.log('BOT_NOT_FOUND');
  process.exit(0);
}

const compRes = await fetch(
  `${base}/api/data/v9.2/botcomponents?$select=name,data,content,componenttype,schemaname&$filter=${encodeURIComponent(`_parentbotid_value eq ${botId}`)}&$top=500`,
  { headers: h },
);
const compJson = (await compRes.json()) as { value?: Array<{ name: string; data?: string; content?: string; componenttype: number; schemaname?: string }> };
const comps = compJson.value ?? [];

const byType = new Map<number, number>();
for (const c of comps) byType.set(c.componenttype, (byType.get(c.componenttype) ?? 0) + 1);
console.log(`Total components: ${comps.length}`);
console.log(`By componenttype: ${[...byType.entries()].map(([t, n]) => `${t}:${n}`).join(', ')}`);

console.log(`\nComponents mentioning "flow" (case-insensitive), full name + componenttype + first 600 chars of data/content:`);
for (const c of comps) {
  const blob = [c.data, c.content].filter(Boolean).join('\n');
  if (!/flow/i.test(blob) && !/flow/i.test(c.name)) continue;
  console.log(`\n--- "${c.name}" (componenttype ${c.componenttype}, schemaname=${c.schemaname ?? '-'}) ---`);
  console.log(blob.slice(0, 600));
}

console.log(`\n\nAll component names + types (so we can see everything, not just flow-name matches):`);
for (const c of comps) console.log(`  [${c.componenttype}] ${c.name}`);
process.exit(0);
