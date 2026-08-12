/** Do connector calls live INSIDE topics (AdaptiveDialog) rather than as TaskDialog tools? */
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
const res = await fetch(
  `${ENV}/api/data/v9.2/botcomponents?$select=name,data,content,componenttype&$filter=_parentbotid_value eq ${bot.botid}`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' } },
);
const comps = ((await res.json()) as any).value as Array<{ name?: string; data?: string; content?: string }>;
for (const c of comps) {
  const blob = `${c.data ?? ''}\n${c.content ?? ''}`;
  const kind = /^\s*kind:\s*(\w+)\s*$/m.exec(blob)?.[1];
  const ops = [...blob.matchAll(/operationId:\s*(\S+)/g)].map((m) => m[1]);
  const conns = [...blob.matchAll(/connectionReference:\s*(\S+)/g)].map((m) => m[1].split('.')[1] ?? m[1]);
  const actions = [...blob.matchAll(/kind:\s*(Invoke\w+Action)/g)].map((m) => m[1]);
  if (!ops.length && !conns.length) continue;
  console.log(`\n[${kind}] ${c.name}`);
  console.log(`   actions: ${[...new Set(actions)].join(', ')}`);
  console.log(`   connectors: ${[...new Set(conns)].join(', ')}`);
  console.log(`   ops: ${[...new Set(ops)].join(', ')}`);
  const inputs = /^\s*inputs:\s*$/m.test(blob);
  console.log(`   has inputs block: ${inputs}`);
}
process.exit(0);
