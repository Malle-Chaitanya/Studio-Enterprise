/** Full payload of one connector tool that has input bindings. Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
const ENV = 'https://org32322095.crm.dynamics.com';
await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const token = await clientCredsToken(row!.tenantId!, ENV);
const res = await fetch(
  `${ENV}/api/data/v9.2/botcomponents?$select=name,data,content&$filter=componenttype eq 9 and statecode eq 0`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' } },
);
const comps = ((await res.json()) as any).value as Array<{ name?: string; data?: string; content?: string }>;
const hit = comps.find((c) => (c.name ?? '').includes('Get existing transformation job'));
console.log(`${hit?.name}\n${'='.repeat(60)}\n${hit?.data ?? hit?.content ?? ''}`.slice(0, 3000));
process.exit(0);
