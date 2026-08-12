/**
 * Every bot row in an environment, UNFILTERED.
 *
 * `listBots` takes only `statecode eq 0`, so an agent the customer can plainly see in
 * Copilot Studio can be absent from our inventory for a reason we never state. When
 * someone names an agent that "does not exist", the honest first question is whether the
 * filter hid it — not whether they misremembered the name.
 *
 * Read-only. Prints names and state, never payload content.
 *
 * npx tsx src/spikes/_dump_all_bots.ts [name fragment]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';

const NEEDLE = process.argv[2];

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

const STATE = ['0 active', '1 inactive'];

for (const env of await discoverEnvironments(tenantId)) {
  let rows: Array<{ name?: string; statecode?: number; statuscode?: number; botid?: string; createdon?: string }>;
  try {
    const token = await clientCredsToken(tenantId, env.url);
    const res = await fetch(
      `${env.url}/api/data/v9.2/bots?$select=name,botid,statecode,statuscode,createdon&$orderby=createdon desc`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) {
      console.log(`\n${env.name}: HTTP ${res.status} — cannot list`);
      continue;
    }
    rows = ((await res.json()) as { value?: typeof rows }).value ?? [];
  } catch (err) {
    console.log(`\n${env.name}: ${(err as Error).message.slice(0, 80)}`);
    continue;
  }

  const shown = NEEDLE ? rows.filter((r) => (r.name ?? '').toLowerCase().includes(NEEDLE.toLowerCase())) : rows;
  const hidden = rows.filter((r) => r.statecode !== 0).length;
  console.log(
    `\n${env.name} — ${rows.length} bot row(s) total, ${hidden} that listBots HIDES (statecode ne 0)` +
      (NEEDLE ? `; ${shown.length} matching "${NEEDLE}"` : ''),
  );
  for (const r of shown) {
    const flag = r.statecode === 0 ? '   ' : '>> ';
    console.log(
      `  ${flag}${(r.name ?? '(unnamed)').slice(0, 46).padEnd(46)} state=${STATE[r.statecode ?? -1] ?? r.statecode} status=${r.statuscode} ${(r.createdon ?? '').slice(0, 10)}`,
    );
  }
}
console.log('\n">>" marks a row listBots excludes — visible in Copilot Studio, invisible to us.');
process.exit(0);
