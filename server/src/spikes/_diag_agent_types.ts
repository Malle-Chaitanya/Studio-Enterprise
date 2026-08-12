/**
 * What KINDS of agent are actually in this tenant, and what does each kind cost us?
 *
 * The `agentIRCache` answer is wrong: it predates tool extraction, so every row reads
 * tools=0 including the twelve agents the connector census proves use connectors. Classify
 * from a FRESH extraction instead — the same `extractAgent` the migration runs.
 *
 * Read-only. Prints shapes and names, never payload content.
 *
 * npx tsx src/spikes/_diag_agent_types.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as
  { tenantId?: string; environments?: Array<{ url: string; name: string }> } | null;
const tenantId = cache!.tenantId!;
const envs = (cache!.environments ?? []).filter((e) =>
  /orga243378d|org32322095/.test(e.url),
);

interface Row {
  env: string;
  name: string;
  instr: number;
  topics: number;
  ks: number;
  tools: number;
  connectorTools: number;
  managed: boolean;
  thin: boolean;
  web: boolean;
  ksKinds: string[];
}
const rows: Row[] = [];

for (const env of envs) {
  const token = await clientCredsToken(tenantId, env.url);
  const bots = await listBots(env.url, token);
  console.log(`${env.name}: ${bots.length} agent(s) — extracting…`);
  for (const bot of bots) {
    try {
      const ir = await extractAgent(env.url, token, bot);
      rows.push({
        env: env.name,
        name: ir.name,
        instr: (ir.instructions ?? '').length,
        topics: (ir.topics ?? []).length,
        ks: (ir.knowledgeSources ?? []).length,
        tools: (ir.agentTools ?? []).length,
        connectorTools: (ir.agentTools ?? []).filter((t) => t.kind === 'connector').length,
        managed: !!ir.isManaged,
        thin: !!ir.thinContent,
        web: !!ir.capabilities?.webBrowsing,
        ksKinds: [...new Set((ir.knowledgeSources ?? []).map((k) => k.classification?.strategy ?? k.kind))],
      });
    } catch (err) {
      console.log(`  ! ${bot.name}: ${(err as Error).message.slice(0, 90)}`);
    }
  }
}

function bucket(r: Row): string {
  if (r.connectorTools > 0 && r.ks > 0) return 'A. Knowledge + live connector tools';
  if (r.connectorTools > 0) return 'B. Connector/tool agents';
  if (r.ks > 0) return 'C. Knowledge agents';
  if (r.instr > 0) return 'D. Instructions + topics only';
  return 'E. Nothing extractable';
}

const byBucket = new Map<string, Row[]>();
for (const r of rows) {
  const b = bucket(r);
  byBucket.set(b, [...(byBucket.get(b) ?? []), r]);
}

console.log(`\n══ ${rows.length} agent(s) across ${envs.length} environment(s)\n`);
for (const [b, list] of [...byBucket.entries()].sort()) {
  console.log(`${b} — ${list.length}`);
  for (const r of list.slice(0, 8)) {
    console.log(
      `   ${r.name.slice(0, 42).padEnd(42)} instr=${String(r.instr).padStart(5)} topics=${String(r.topics).padStart(3)} ks=${r.ks} tools=${r.tools}(${r.connectorTools} conn)${r.managed ? ' MANAGED' : ''}${r.web ? ' web' : ''}`,
    );
  }
  if (list.length > 8) console.log(`   … +${list.length - 8} more`);
  const kinds = [...new Set(list.flatMap((r) => r.ksKinds))];
  if (kinds.length) console.log(`   knowledge strategies seen: ${kinds.join(', ')}`);
  console.log('');
}

console.log(`managed/prebuilt (Microsoft-authored): ${rows.filter((r) => r.managed).length}`);
console.log(`with web browsing on: ${rows.filter((r) => r.web).length}`);
console.log(`thin (no authored content): ${rows.filter((r) => r.thin).length}`);
// The one fidelity cost we can quantify up front: ADK cannot combine VertexAiSearchTool
// grounding with googleSearch, so any agent that has BOTH knowledge and web browsing
// loses the web browsing.
const losesWeb = rows.filter((r) => r.web && r.ks > 0);
console.log(`would LOSE web browsing (has knowledge + web): ${losesWeb.length} — ${losesWeb.map((r) => r.name).slice(0, 6).join(', ')}`);
const dvBlocked = rows.filter((r) => r.ksKinds.includes('dataverse-snapshot'));
console.log(`knowledge needs the Dataverse application-user grant: ${dvBlocked.length}`);
process.exit(0);
