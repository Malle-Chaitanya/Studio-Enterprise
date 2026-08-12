/** Why does the census see tools that extraction does not? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const ENV = 'https://org32322095.crm.dynamics.com';
const NAME = process.argv[2] ?? 'Case Management';
await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const token = await clientCredsToken(row!.tenantId!, ENV);
const bots = await listBots(ENV, token);
const bot = bots.find((b) => b.name.toLowerCase().includes(NAME.toLowerCase()))!;
console.log(`bot ${bot.name} ${bot.botid}`);

async function all(path: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = `${ENV}/api/data/v9.2/${path}`;
  while (next) {
    const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' } });
    if (!res.ok) { console.log(`  ${res.status} ${(await res.text()).slice(0, 200)}`); break; }
    const j = (await res.json()) as any;
    out.push(...(j.value ?? []));
    next = j['@odata.nextLink'] ?? null;
  }
  return out;
}

const comps = await all(`botcomponents?$select=name,componenttype,statecode,statuscode,ismanaged&$filter=_parentbotid_value eq ${bot.botid}`);
const byState = new Map<string, number>();
for (const c of comps) {
  const k = `type=${c.componenttype} statecode=${c.statecode} managed=${c.ismanaged}`;
  byState.set(k, (byState.get(k) ?? 0) + 1);
}
console.log(`total components: ${comps.length}`);
for (const [k, n] of [...byState].sort()) console.log(`  ${n.toString().padStart(4)}  ${k}`);
process.exit(0);
