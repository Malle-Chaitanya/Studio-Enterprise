/** COVERAGE AUDIT: what does Dataverse hold for an agent, and what does the IR keep?
 *
 *  The pipeline's first principle is lossless extraction, so the question "are we getting
 *  everything from the agent?" has to be answered against the raw components, not against
 *  what the IR happens to contain. Every raw component is bucketed as captured / dropped,
 *  and the bot's own configuration flags are checked one by one.
 *
 *  npx tsx src/spikes/_diag_extraction_coverage.ts <envUrl> <botId>
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const ENV = process.argv[2]!.replace(/\/$/, '');
const BOT = process.argv[3]!;

const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = (await mc.db(config.CSGE_DB).collection('environmentsCache')
  .find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
await mc.close();
const token = await clientCredsToken(cached!.tenantId!, ENV);

const raw = await (await fetch(
  `${ENV}/api/data/v9.2/botcomponents?$select=name,data,content,componenttype,schemaname&$filter=${encodeURIComponent(`_parentbotid_value eq ${BOT}`)}&$top=500`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
)).json() as { value?: Array<Record<string, any>> };
const comps = raw.value ?? [];

const bot = (await listBots(ENV, token)).find((b: any) => b.botid === BOT)!;
const ir = await extractAgent(ENV, token, bot);

const kindOf = (c: Record<string, any>) =>
  /^\s*kind:\s*(\w+)/m.exec(c.data || c.content || '')?.[1] ?? '(no kind)';

// ── Bucket every component ────────────────────────────────────────────────────
const buckets = new Map<string, { total: number; captured: number; examples: string[] }>();
for (const c of comps) {
  const key = `type ${c.componenttype} · ${kindOf(c)}`;
  const b = buckets.get(key) ?? { total: 0, captured: 0, examples: [] };
  b.total++;

  const name = c.name ?? '';
  const captured =
    ir.topics.some((t) => t.name === name) ||
    (ir.agentTools ?? []).some((t) => t.name === name) ||
    ir.knowledgeSources.some((k) => k.name === name) ||
    // the CustomGpt component is captured as instructions/description, not by name
    (c.componenttype === 15 && ir.instructions.length > 0);
  if (captured) b.captured++;
  else if (b.examples.length < 3) b.examples.push(name || c.schemaname || '(unnamed)');
  buckets.set(key, b);
}

console.log(`AGENT: ${ir.name}`);
console.log(`raw components: ${comps.length}\n`);
console.log('bucket                                   total  kept  dropped');
console.log('─'.repeat(72));
let droppedTotal = 0;
for (const [key, b] of [...buckets].sort()) {
  const dropped = b.total - b.captured;
  droppedTotal += dropped;
  console.log(`${key.padEnd(40)} ${String(b.total).padStart(5)} ${String(b.captured).padStart(5)} ${String(dropped).padStart(8)}`);
  if (dropped && b.examples.length) console.log(`    e.g. ${b.examples.join(' | ')}`);
}
console.log('─'.repeat(72));
console.log(`TOTAL DROPPED: ${droppedTotal}\n`);

// ── Bot-level configuration flags ─────────────────────────────────────────────
const cfg = typeof (bot as any).configuration === 'string' ? (bot as any).configuration : '';
const flags = [...cfg.matchAll(/"(\w+)":\s*(true|false|"[^"]*")/g)].map((m) => `${m[1]}=${m[2]}`);
console.log('bot configuration flags found in Dataverse:');
for (const f of flags) console.log(`  ${f}`);
console.log(`\nIR capabilities: ${JSON.stringify(ir.capabilities)}`);
console.log(`IR unmapped (${ir.unmapped.length}): ${JSON.stringify(ir.unmapped)}`);
console.log(`IR topics=${ir.topics.length} agentTools=${ir.agentTools?.length ?? 0} knowledge=${ir.knowledgeSources.length}`);
console.log(`IR instructions=${ir.instructions.length}ch description=${ir.description.length}ch starters=${ir.starterPrompts.length}`);
process.exit(0);
