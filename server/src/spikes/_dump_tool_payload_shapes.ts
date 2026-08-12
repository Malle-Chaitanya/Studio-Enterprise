/**
 * What do the tool payloads actually contain — specifically, the INPUT BINDINGS we do not
 * extract today, and the non-connector action kinds (AI plugin, flow, external agent)?
 *
 * Prints structure, trimmed. Read-only, nothing committed.
 * npx tsx src/spikes/_dump_tool_payload_shapes.ts
 */
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

const want = ['InvokeAIPluginTaskAction', 'InvokeFlowTaskAction', 'InvokeExternalAgentTaskAction', 'InvokeConnectorTaskAction'];
for (const kind of want) {
  const hit = comps.find((c) => {
    const b = `${c.data ?? ''}\n${c.content ?? ''}`;
    return b.includes(kind) && /^\s*(inputs|parameters):\s*$/m.test(b);
  }) ?? comps.find((c) => `${c.data ?? ''}\n${c.content ?? ''}`.includes(kind));
  console.log(`\n════════ ${kind} — ${hit?.name ?? 'NONE FOUND'} ════════`);
  if (!hit) continue;
  const blob = `${hit.data ?? ''}\n${hit.content ?? ''}`;
  // The action block only: from the action kind line to the end, capped.
  const i = blob.indexOf(kind);
  console.log(blob.slice(Math.max(0, i - 400), i + 1400));
}
process.exit(0);
