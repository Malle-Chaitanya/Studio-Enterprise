/** Dump one agent's raw component bodies, to confirm a blind-spot lead by hand. Read-only.
 *  Run: npx tsx src/spikes/_dump_component.ts "<agentName>" "<componentNameFilter>" [envUrl] */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent, type RawAgentPayload } from '../services/dataverse.js';

const AGENT = process.argv[2] ?? '';
const COMP = (process.argv[3] ?? '').toLowerCase();
const ENV = process.argv[4] ?? 'https://org32322095.crm.dynamics.com';

await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const token = await clientCredsToken(row!.tenantId!, ENV);
const bots = await listBots(ENV, token);
const bot = bots.find((b) => b.name.toLowerCase().includes(AGENT.toLowerCase()));
if (!bot) { console.error(`no agent matching "${AGENT}"`); process.exit(1); }

let raw: RawAgentPayload | undefined;
const ir = await extractAgent(ENV, token, bot, (r) => { raw = r; });
console.log(`\n### ${bot.name} — ${raw?.components.length ?? 0} components, parser found ${(ir.agentTools ?? []).length} tool(s)`);
for (const t of ir.agentTools ?? []) console.log(`  PARSER TOOL: "${t.name}" conn=${t.connectorId ?? '-'} op=${t.operationId ?? '-'}`);

for (const c of raw?.components ?? []) {
  const row2 = (c ?? {}) as Record<string, unknown>;
  const name = String(row2.name ?? '');
  if (COMP && !name.toLowerCase().includes(COMP)) continue;
  const body = String(row2.data ?? row2.content ?? '');
  console.log(`\n═══ component: ${name} (type=${String(row2.componenttype)}) — ${body.length} chars ═══`);
  console.log(body.slice(0, 4000));
}
process.exit(0);
