/** Full data of specific components — hunting the connector identity for ACTION-based
 *  connector use (topics that call a connector), which the knowledge scan never sees.
 *  npx tsx src/spikes/_diag_component_dump.ts <envUrl> <botId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';
const ENV = process.argv[2]!, BOT = process.argv[3]!;
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const r = await fetch(`${ENV.replace(/\/$/, '')}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(`_parentbotid_value eq ${BOT}`)}&$top=50`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
const rows = ((await r.json()) as { value?: Array<Record<string, any>> }).value ?? [];
for (const c of rows) {
  console.log(`\n═══ type ${c.componenttype} · "${c.name ?? '(unnamed)'}" ═══`);
  console.log(`schemaname: ${c.schemaname ?? '-'}`);
  for (const field of ['data', 'content']) {
    const v = c[field];
    if (typeof v === 'string' && v.length) {
      console.log(`--- ${field} (${v.length} chars) ---`);
      console.log(v.slice(0, 1200));
    }
  }
}
process.exit(0);
