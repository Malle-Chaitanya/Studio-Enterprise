/**
 * WHY do some SharePoint knowledge sources carry no resolvable URL?
 *
 * Two sources on "Knowledge Assistant" and one on "HR AGENT" fall back to the broken
 * native connector purely because copy mode had no address to resolve. Fixing that is
 * worth more than any new feature: it converts a fallback into the proven path.
 *
 * Prints the RAW source shape, so the fix is driven by what Copilot actually stores.
 *
 * Read-only.  npx tsx src/spikes/_diag_sp_missing_url.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const WANTED = ['knowledge assistant', 'hr agent', 'cloudfuze studio migrate'];
await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try { token = await clientCredsToken(tenantId, env.url); bots = await listBots(env.url, token); } catch { continue; }
  for (const bot of bots.filter((b) => WANTED.some((w) => b.name.toLowerCase() === w))) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    console.log(`\n${'='.repeat(78)}\n  ${ir.name}   [${env.name}]\n${'='.repeat(78)}`);
    for (const k of ir.knowledgeSources ?? []) {
      const blob = JSON.stringify(k, null, 1);
      if (!/sharepoint/i.test(blob)) continue;
      console.log(`\n  source "${k.name}"  kind=${k.kind}`);
      console.log(`  strategy=${k.classification?.strategy ?? '?'}`);
      console.log(blob.slice(0, 2600));
    }
  }
}
process.exit(0);
