/**
 * What does Copilot Studio's "memory" actually look like in Dataverse?
 *
 * We extract topics, tools and knowledge. Memory is a fourth thing the maker configures
 * in the UI and we have never looked at it. Before deciding how to migrate it, find out
 * where it lives: a column on the bot, a botcomponent type we skip, or a separate table.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_probe_memory.ts [envUrl]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const ENV = process.argv[2] ?? 'https://orga243378d.crm.dynamics.com';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const token = await clientCredsToken(cache!.tenantId!, ENV);

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ENV}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${path} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// 1. Which bot columns even mention memory?
const meta = await get<{ value: Array<{ LogicalName: string }> }>(
  `EntityDefinitions(LogicalName='bot')/Attributes?$select=LogicalName`,
);
const memCols = meta.value.map((a) => a.LogicalName).filter((n) => /memor|recall|personal|context/i.test(n));
console.log(`bot columns matching memory/recall/personalization/context: ${memCols.join(', ') || '(none)'}\n`);

// 2. Every botcomponent type in this environment, with counts — memory would be a type
//    we currently skip (we only read 9, 14, 15, 16).
const comps = await get<{ value: Array<{ componenttype: number; name: string }> }>(
  `botcomponents?$select=componenttype,name&$top=5000`,
);
const byType = new Map<number, { n: number; sample: string[] }>();
for (const c of comps.value) {
  const e = byType.get(c.componenttype) ?? { n: 0, sample: [] };
  e.n++;
  if (e.sample.length < 3) e.sample.push(c.name ?? '(unnamed)');
  byType.set(c.componenttype, e);
}
console.log('botcomponent types present:');
for (const [t, e] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
  const known = [9, 14, 15, 16].includes(t) ? 'READ' : 'not read';
  console.log(`  type=${String(t).padStart(3)}  ${String(e.n).padStart(4)}  [${known}]  ${e.sample.join(' | ')}`);
}

// 3. Tables whose name suggests memory.
const ents = await get<{ value: Array<{ LogicalName: string }> }>(
  `EntityDefinitions?$select=LogicalName`,
);
const memTables = ents.value.map((e) => e.LogicalName).filter((n) => /memor|conversationtranscript|agentprofile/i.test(n));
console.log(`\ntables matching memory/transcript/agentprofile: ${memTables.join(', ') || '(none)'}`);

process.exit(0);
