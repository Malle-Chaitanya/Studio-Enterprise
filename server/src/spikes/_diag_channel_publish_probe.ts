/** Live probe: does bots.configuration or bots.applicationmanifestinformation
 *  carry per-channel (Teams/SharePoint/M365 Copilot) enablement state, or is
 *  it purely a publish-state + share-list split as suspected?
 *  Read-only. npx tsx src/spikes/_diag_channel_publish_probe.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

interface EnvCacheRow {
  tenantId: string;
  environments: { name: string; url: string; accessible: boolean }[];
}

async function main() {
  await connectMongo();
  const row = await getDb()
    .collection<EnvCacheRow>('environmentsCache')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next();
  if (!row) throw new Error('no environmentsCache entry');

  const env = row.environments.find((e) => /migration hub/i.test(e.name)) ?? row.environments[0];
  console.log(`Using environment: ${env.name} (${env.url})\n`);

  const token = await clientCredsToken(row.tenantId, env.url);

  const listRes = await fetch(
    `${env.url}/api/data/v9.2/bots?$select=name,botid&$filter=statecode eq 0`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  const list = (await listRes.json()) as { value: { name: string; botid: string }[] };
  console.log(`Found ${list.value.length} active bot(s):`);
  list.value.forEach((b) => console.log(`  - ${b.name} (${b.botid})`));

  const target = list.value.find((b) => /knowledge assistant/i.test(b.name)) ?? list.value[0];
  if (!target) throw new Error('no bot found to probe');
  console.log(`\nProbing: ${target.name}\n`);

  for (const field of ['configuration', 'applicationmanifestinformation', 'publishedon,statecode']) {
    try {
      const res = await fetch(
        `${env.url}/api/data/v9.2/bots(${target.botid})?$select=${field}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      );
      const body = await res.text();
      console.log(`--- $select=${field}  (status ${res.status}) ---`);
      console.log(body.slice(0, 4000));
      console.log();
    } catch (e) {
      console.log(`--- $select=${field} FAILED: ${(e as Error).message} ---\n`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
