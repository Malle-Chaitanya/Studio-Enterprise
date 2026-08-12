/** One InvokeConnectorAction block from inside a topic, verbatim. Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
const ENV = 'https://org32322095.crm.dynamics.com';
await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const token = await clientCredsToken(row!.tenantId!, ENV);
const bots = await listBots(ENV, token);
const bot = bots.find((b) => b.name.includes('Case Management'))!;
const res = await fetch(
  `${ENV}/api/data/v9.2/botcomponents?$select=name,data,content&$filter=_parentbotid_value eq ${bot.botid}`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' } },
);
const comps = ((await res.json()) as any).value as Array<{ name?: string; data?: string; content?: string }>;
const hit = comps.find((c) => (c.name ?? '').includes('Resolve a case'))!;
const blob = `${hit.data ?? ''}\n${hit.content ?? ''}`;
const i = blob.indexOf('InvokeConnectorAction');
console.log(blob.slice(Math.max(0, i - 700), i + 900));
process.exit(0);
