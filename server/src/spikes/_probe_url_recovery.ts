/**
 * Does recoverSharePointUrlByName() actually find the addresses the sources are missing?
 *
 * Runs the real function against the real environment for every SharePoint source that
 * stored no address. A recovery converts a source from the broken native-connector
 * fallback onto the proven copy-mode path, so this is the check that decides whether the
 * fix is worth anything.
 *
 * Read-only.  npx tsx src/spikes/_probe_url_recovery.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { recoverSharePointUrlByName } from '../services/sharePointUrlRecovery.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

let recovered = 0;
let refused = 0;
for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try { token = await clientCredsToken(tenantId, env.url); bots = await listBots(env.url, token); } catch { continue; }
  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    for (const k of ir.knowledgeSources ?? []) {
      if (!/sharepoint/i.test(JSON.stringify(k))) continue;
      const have = (k.reference ?? k.references?.[0] ?? '').trim();
      if (/^https?:\/\//i.test(have)) continue; // already had one
      const rec = await recoverSharePointUrlByName(env.url, token, k.name);
      if (rec.status === 'recovered') recovered++; else refused++;
      console.log(`  ${rec.status.toUpperCase().padEnd(10)} ${ir.name} :: ${k.name}`);
      if (rec.status === 'recovered') console.log(`             ${rec.url}\n             from ${rec.fromSchemaName}`);
      if (rec.status === 'ambiguous') console.log(`             ${rec.urls.join('\n             ')}`);
    }
  }
}
console.log(`\n${recovered} address(es) recovered · ${refused} left for a human`);
process.exit(0);
