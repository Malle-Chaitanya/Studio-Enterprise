/** How is an agent linked to its connectors in Dataverse?
 *  Knowledge sources carry _parentbotid_value (direct link). Power Automate flows are
 *  environment-level — this checks whether the agent's own components reference a
 *  workflow id, which would give us the missing agent→flow→connector chain.
 *  npx tsx src/spikes/_diag_agent_flow_link.ts <envUrl> <botId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';

const ENV = process.argv[2] ?? 'https://org32322095.crm.dynamics.com';
const BOT = process.argv[3] ?? '';
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const base = ENV.replace(/\/$/, '');
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

// 1. Every component of this agent, by type.
const r = await fetch(`${base}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(`_parentbotid_value eq ${BOT}`)}&$top=200`, { headers: h });
const j = await r.json() as { value?: Array<Record<string, any>> };
const comps = j.value ?? [];
const byType = new Map<number, number>();
for (const c of comps) byType.set(c.componenttype, (byType.get(c.componenttype) ?? 0) + 1);
console.log(`${comps.length} component(s) for this agent`);
console.log(`  by componenttype: ${[...byType].map(([t, n]) => `${t}:${n}`).join(', ')}`);

// 2. Do any of them reference a Power Automate flow (a workflow GUID)?
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const flowRefs = new Set<string>();
for (const c of comps) {
  const blob = [c.data, c.content, c.description, c.schemaname].filter(Boolean).join('\n');
  if (!/workflow|flow|powerautomate|shared_/i.test(blob)) continue;
  for (const g of blob.match(GUID) ?? []) flowRefs.add(g.toLowerCase());
  console.log(`\n  component "${c.name}" (type ${c.componenttype}) mentions a flow:`);
  console.log(`    ${blob.replace(/\s+/g, ' ').slice(0, 220)}`);
}

// 3. Cross-check any GUIDs against real flows in this environment.
if (flowRefs.size) {
  const wf = await fetch(`${base}/api/data/v9.2/workflows?$filter=category eq 5&$select=workflowid,name&$top=200`, { headers: h });
  const wj = await wf.json() as { value?: Array<{ workflowid: string; name: string }> };
  const known = new Map((wj.value ?? []).map((w) => [w.workflowid.toLowerCase(), w.name]));
  const hits = [...flowRefs].filter((g) => known.has(g));
  console.log(`\n  GUIDs referenced: ${flowRefs.size}, matching real flows: ${hits.length}`);
  for (const g of hits) console.log(`    ${g} -> ${known.get(g)}`);
} else {
  console.log('\n  no flow references found in this agent\'s components');
}
process.exit(0);
