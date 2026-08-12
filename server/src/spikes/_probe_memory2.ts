/**
 * The memory tables exist (see _probe_memory.ts). Do they hold anything, and what shape?
 *
 * Read-only. Prints COLUMN NAMES and row counts; prints values only for non-personal
 * config columns, because agent memory is by definition customer conversation content.
 *
 * npx tsx src/spikes/_probe_memory2.ts [envUrl]
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

async function get<T>(path: string): Promise<T | { __error: string }> {
  const res = await fetch(`${ENV}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return { __error: `${res.status} ${(await res.text()).slice(0, 160).replace(/\s+/g, ' ')}` };
  return res.json() as Promise<T>;
}

for (const table of ['agentmemory', 'intelligentmemory', 'conversationtranscript']) {
  console.log(`\n── ${table}`);
  const meta = await get<{ value: Array<{ LogicalName: string; AttributeType: string }> }>(
    `EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName,AttributeType`,
  );
  if ('__error' in meta) {
    console.log(`   metadata: ${meta.__error}`);
  } else {
    const cols = meta.value
      .map((a) => a.LogicalName)
      .filter((n) => !n.startsWith('_') && !/^(createdon|modifiedon|createdby|modifiedby|owner|versionnumber|statecode|statuscode|importsequencenumber|overriddencreatedon|timezoneruleversionnumber|utcconversiontimezonecode)/.test(n))
      .sort();
    console.log(`   columns (${meta.value.length} total): ${cols.join(', ')}`);
  }
  // Dataverse pluralises these as -ies / -s; try both rather than guess.
  const plural = table.endsWith('y') ? `${table.slice(0, -1)}ies` : `${table}s`;
  const rows = await get<{ value: unknown[] }>(`${plural}?$top=3`);
  if ('__error' in rows) console.log(`   rows: ${rows.__error}`);
  else {
    console.log(`   rows returned (top 3): ${rows.value.length}`);
    // Key names only — the values are customer conversation content.
    for (const r of rows.value) console.log(`     keys: ${Object.keys(r as object).filter((k) => !k.startsWith('@')).join(', ')}`);
  }
}

// The one botcomponent type we saw but do not read.
const t18 = await get<{ value: Array<{ name: string; componenttype: number; schemaname?: string; data?: string; content?: string }> }>(
  `botcomponents?$filter=componenttype eq 18&$select=name,schemaname,componenttype,data,content&$top=3`,
);
console.log('\n── botcomponent type 18 (unread by extraction)');
if ('__error' in t18) console.log(`   ${t18.__error}`);
else for (const c of t18.value) {
  const body = c.data || c.content || '';
  console.log(`   name=${c.name ?? '(unnamed)'} schema=${c.schemaname ?? '-'} bodyLen=${body.length}`);
  console.log(`   head: ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
}

process.exit(0);
