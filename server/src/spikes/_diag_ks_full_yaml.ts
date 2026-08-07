/** Full YAML of one knowledge-source component — find where the connector identity is.
 *  npx tsx src/spikes/_diag_ks_full_yaml.ts <envUrl> <botId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';
const ENV = process.argv[2]!, BOT = process.argv[3]!;
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const url = `${ENV.replace(/\/$/, '')}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(`componenttype eq 16 and _parentbotid_value eq ${BOT}`)}&$top=5`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
const j = await r.json() as { value?: Array<Record<string, any>> };
for (const c of j.value ?? []) {
  console.log(`\n═══ ${c.name} ═══`);
  console.log('--- data ---');
  console.log(String(c.data ?? '(empty)'));
  // Other fields may carry the connection reference that names the connector.
  for (const [k, v] of Object.entries(c)) {
    if (['data', 'content', 'name'].includes(k)) continue;
    if (typeof v === 'string' && /confluence|shared_|apiname|connector/i.test(v)) console.log(`  ${k}: ${v}`);
  }
}
process.exit(0);
