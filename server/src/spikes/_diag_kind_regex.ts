/** Replicate the two-tier parse against real rows to see which tier fires.
 *  npx tsx src/spikes/_diag_kind_regex.ts <envUrl> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';
const ENV = process.argv[2] ?? 'https://orga243378d.crm.dynamics.com';
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const url = `${ENV.replace(/\/$/, '')}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent('componenttype eq 16')}&$top=20`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
const rows = ((await r.json()) as { value?: Array<Record<string, any>> }).value ?? [];
for (const c of rows) {
  const data = c.data || c.content || '';
  const m = /source:\s*[\s\S]*?kind:\s*([A-Za-z0-9_]+)/.exec(data);
  const shared = [...String(data).matchAll(/shared_[a-z0-9_]+/gi)].map((x) => x[0]);
  console.log(`\n${c.name}`);
  console.log(`  kind captured : ${m?.[1] ?? '(no match)'}`);
  console.log(`  shared_* found: ${shared.join(', ') || '-'}`);
  console.log(`  data head     : ${String(data).replace(/\s+/g, ' ').slice(0, 90)}`);
}
process.exit(0);
