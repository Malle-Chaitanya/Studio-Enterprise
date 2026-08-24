/** Live probe: does the WorkMate agent's bots.configuration /
 *  applicationmanifestinformation on the source (Dataverse) side show
 *  Teams-channel publish enabled? Read-only.
 *  npx tsx src/spikes/_diag_workmate_channel_probe.ts */
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

  for (const env of row.environments.filter((e) => e.accessible)) {
    const token = await clientCredsToken(row.tenantId, env.url);
    const listRes = await fetch(
      `${env.url}/api/data/v9.2/bots?$select=name,botid,publishedon,statecode&$filter=contains(name,'WorkMate') or contains(name,'Workmate') or contains(name,'workmate')`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!listRes.ok) { console.log(`${env.name}: list failed (${listRes.status})`); continue; }
    const list = (await listRes.json()) as { value: { name: string; botid: string }[] };
    if (list.value.length === 0) { console.log(`${env.name}: no WorkMate bot`); continue; }

    for (const bot of list.value) {
      console.log(`\n=== ${env.name} :: ${bot.name} (${bot.botid}) ===`);
      for (const field of ['configuration', 'applicationmanifestinformation', 'publishedon,statecode']) {
        const res = await fetch(
          `${env.url}/api/data/v9.2/bots(${bot.botid})?$select=${field}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
        );
        const body = await res.text();
        console.log(`--- $select=${field}  (status ${res.status}) ---`);
        console.log(body.slice(0, 4000));
      }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
