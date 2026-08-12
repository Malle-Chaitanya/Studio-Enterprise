/**
 * Does a FederatedStructuredSearchSource's opaque `skillConfiguration` id resolve to a
 * real SharePoint address anywhere in Dataverse?
 *
 * If it does, two "unmigratable" sources become copy-mode sources — the highest-value
 * SharePoint fix available, because it converts a fallback onto the proven path. If it
 * does not, that is worth knowing definitively rather than assuming.
 *
 * Read-only: reads botcomponents and connection references, writes nothing.
 *
 * npx tsx src/spikes/_probe_skillconfig.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';

const IDS = ['TestingPermissions_3XBDJPyZ3T4MgfrMTwiYX', 'daily_queriestxt_ZEHQ13QHyGoE_iNOUiCtg'];

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

async function get(url: string, token: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
  });
  if (!res.ok) return { __error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return res.json();
}

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  try { token = await clientCredsToken(tenantId, env.url); } catch { continue; }
  const base = env.url.replace(/\/$/, '');

  for (const id of IDS) {
    // Every botcomponent whose payload MENTIONS the id — the config may live on a
    // different component than the knowledge source that references it.
    const q = `${base}/api/data/v9.2/botcomponents?$select=botcomponentid,name,componenttype,schemaname,data,content&$filter=contains(name,'${id.split('_')[0]}')`;
    const r = await get(q, token);
    if (r.__error) { console.log(`  [${env.name}] name-search failed: ${r.__error.slice(0, 90)}`); continue; }
    const rows = (r.value ?? []) as any[];
    if (!rows.length) continue;
    console.log(`\n${'='.repeat(78)}\n  ${id}   [${env.name}] — ${rows.length} component(s) by name\n${'='.repeat(78)}`);
    for (const c of rows) {
      const payload = `${c.data ?? ''}${c.content ?? ''}`;
      const urls = [...new Set([...payload.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]))];
      console.log(`\n  componenttype=${c.componenttype}  name=${c.name}  schema=${c.schemaname ?? '-'}`);
      console.log(`     payload ${payload.length} char(s); ${urls.length} URL(s)`);
      for (const u of urls.slice(0, 6)) console.log(`       ${u.slice(0, 150)}`);
      if (!urls.length && payload) console.log(`     head: ${payload.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
}
process.exit(0);
