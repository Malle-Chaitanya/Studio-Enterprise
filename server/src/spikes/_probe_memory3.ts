/**
 * How does a memory row link back to a bot?
 *
 * Extraction is per-agent. If `intelligentmemory` carries no agent lookup, memory can
 * only be migrated tenant-wide, which is a different (and much more sensitive) product
 * decision than "migrate this agent's memory". Settle that before writing any extractor.
 *
 * Read-only. Prints SCHEMA only — no memory values.
 *
 * npx tsx src/spikes/_probe_memory3.ts [envUrl]
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

interface Attr {
  LogicalName: string;
  AttributeType: string;
  Targets?: string[];
  MaxLength?: number;
  Description?: { UserLocalizedLabel?: { Label?: string } };
}

for (const table of ['intelligentmemory', 'agentmemory']) {
  console.log(`\n═══ ${table}`);
  const meta = await get<{ value: Attr[] }>(
    `EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName,AttributeType,Description`,
  );
  if ('__error' in meta) {
    console.log(`  ${meta.__error}`);
    continue;
  }
  const noise =
    /^(createdon|modifiedon|createdby|modifiedby|modifiedonbehalfby|createdonbehalfby|owner|ownerid|owning|versionnumber|statecode|statuscode|importsequencenumber|overriddencreatedon|timezoneruleversionnumber|utcconversiontimezonecode|solutionid|supportingsolutionid|overwritetime|componentstate|ismanaged|componentidunique)/;
  for (const a of meta.value.filter((x) => !noise.test(x.LogicalName)).sort((x, y) => x.LogicalName.localeCompare(y.LogicalName))) {
    const desc = a.Description?.UserLocalizedLabel?.Label ?? '';
    console.log(`  ${a.LogicalName.padEnd(28)} ${a.AttributeType.padEnd(10)} ${desc.slice(0, 90)}`);
  }
  // Lookups are what would tie a row to a bot.
  const rels = await get<{ value: Array<{ ReferencingAttribute: string; ReferencedEntity: string }> }>(
    `EntityDefinitions(LogicalName='${table}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity`,
  );
  if (!('__error' in rels)) {
    const interesting = rels.value.filter((r) => !/^(owner|business|team|systemuser|transactioncurrency)/.test(r.ReferencedEntity));
    console.log(`  ── lookups: ${interesting.map((r) => `${r.ReferencingAttribute}→${r.ReferencedEntity}`).join(', ') || '(none beyond ownership)'}`);
  }
}

process.exit(0);
