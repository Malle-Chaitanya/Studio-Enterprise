/**
 * Is a "thin" agent really empty, or does its content sit somewhere we do not read?
 *
 * `thinContent` means no instructions, no readable topic summary, no AI prompt. An agent
 * with 5 custom topics that still reports thin is either genuinely a set of empty stubs or
 * a gap in what we parse — and the two look identical from the outside. Print what each
 * topic component actually holds so the answer is read, not assumed.
 *
 * Read-only. Prints structure and action kinds, not customer payload text.
 *
 * npx tsx src/spikes/_probe_thin_agent.ts "<agent name fragment>"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const NEEDLE = process.argv[2];
if (!NEEDLE) {
  console.error('usage: _probe_thin_agent.ts "<agent name fragment>"');
  process.exit(1);
}

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch {
    continue;
  }
  const bot = bots.find((b) => b.name.toLowerCase().includes(NEEDLE.toLowerCase()));
  if (!bot) continue;

  console.log(`\n${bot.name}  (${env.name})\n${'='.repeat(70)}`);
  const res = await fetch(
    `${env.url}/api/data/v9.2/botcomponents?$filter=_parentbotid_value eq ${bot.botid}` +
      `&$select=name,componenttype,schemaname,data,content`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  const comps = ((await res.json()) as {
    value?: Array<{ name?: string; componenttype?: number; schemaname?: string; data?: string; content?: string }>;
  }).value ?? [];

  const byType = new Map<number, number>();
  for (const c of comps) byType.set(c.componenttype ?? -1, (byType.get(c.componenttype ?? -1) ?? 0) + 1);
  console.log(`components by type: ${[...byType.entries()].map(([t, n]) => `${t}=${n}`).join(', ')}`);

  for (const c of comps) {
    const payload = c.data || c.content || '';
    const kinds = [...new Set([...payload.matchAll(/^\s*kind:\s*(\w+)\s*$/gm)].map((m) => m[1]))];
    console.log(`\n  [type ${c.componenttype}] ${c.name ?? '(unnamed)'}`);
    console.log(`     schemaName: ${c.schemaname ?? '(none)'}`);
    console.log(`     payload:    ${payload.length} chars`);
    console.log(`     kinds:      ${kinds.join(', ') || '(none)'}`);
    // The two markers that decide whether a topic carries behaviour we must migrate.
    const hasConnector = /InvokeConnectorAction|InvokeConnectorTaskAction/.test(payload);
    const hasMessage = /SendActivity|sendActivity/.test(payload);
    if (hasConnector) console.log('     >> CONTAINS A CONNECTOR CALL');
    if (hasMessage) console.log('     >> sends a message');
    if (payload.length && payload.length < 2500) {
      console.log('     ── full payload (short) ──');
      console.log(payload.split('\n').map((l) => `     | ${l}`).join('\n'));
    }
  }
}
process.exit(0);
