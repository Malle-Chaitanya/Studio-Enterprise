/** Find WHERE the description is stored — raw-search the full bot record + every
 *  component for the known description text.
 *   npx tsx src/spikes/_diag_find_desc.ts <envUrl> <botId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const [ENV, BOTID] = process.argv.slice(2);
const NEEDLE = /cloudfuze migration|leave policy|helper/i;

async function main() {
  if (!ENV || !BOTID) throw new Error('usage: _diag_find_desc.ts <envUrl> <botId>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
  const token = await clientCredsToken(s!.tenantId!, ENV);
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  const bot = (await (await fetch(`${ENV}/api/data/v9.2/bots(${BOTID})`, { headers: h })).json()) as Record<string, unknown>;
  console.log('===== full configuration =====');
  console.log(String(bot.configuration ?? '(none)'));
  console.log('\n===== bot record: does any field contain the description text? =====');
  for (const [k, v] of Object.entries(bot)) {
    if (typeof v === 'string' && NEEDLE.test(v)) console.log(`  >>> bot.${k}: ...${v.match(NEEDLE)?.input?.slice(Math.max(0, (v.search(NEEDLE)) - 30), v.search(NEEDLE) + 70)}...`);
  }

  const comps = (await (await fetch(`${ENV}/api/data/v9.2/botcomponents?$select=name,data,componenttype&$filter=_parentbotid_value eq ${BOTID}`, { headers: h })).json()) as { value?: { name?: string; data?: string; componenttype?: number }[] };
  console.log(`\n===== ${comps.value?.length ?? 0} components: which contain the description text? =====`);
  for (const c of comps.value ?? []) {
    const raw = c.data ?? '';
    if (NEEDLE.test(raw) || NEEDLE.test(c.name ?? '')) {
      const at = raw.search(NEEDLE);
      console.log(`  >>> componenttype=${c.componenttype} name="${c.name}"`);
      if (at >= 0) console.log(`      ...${raw.slice(Math.max(0, at - 40), at + 90).replace(/\n/g, ' ')}...`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
