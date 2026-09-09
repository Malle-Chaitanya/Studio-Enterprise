/**
 * Why does parseMcpBinding return toolSelection:'unknown' for the HubSpot MCP tool
 * on the Meeting Intelligence Agent, while it works for Mail/Calendar? Dump the raw,
 * unparsed component payload to see the actual shape.
 *
 * Read-only. Prints structure and ids, never credential values.
 *
 * npx tsx src/spikes/_diag_hubspot_raw_payload.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true, $ne: '' } })
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
  const match = bots.find((b) => /meeting.?intelligence/i.test(b.name));
  if (!match) continue;

  await extractAgent(env.url, token, match, (raw) => {
    for (const c of raw.components as any[]) {
      const data = c.data || c.content || '';
      if (/hubspot/i.test(c.name ?? '') || /hubspot/i.test(data)) {
        console.log(`\n══ RAW component: "${c.name}" (componenttype=${c.componenttype})\n`);
        console.log(data);
        console.log('\n── end of component ──\n');
      }
    }
  });
  process.exit(0);
}
console.log('Agent not found.');
process.exit(0);
