import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const TABLES = ['unstructuredfilesearchentity', 'unstructuredfilesearchrecord'];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  for (const env of s.environments ?? []) {
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    const probe = await fetch(`${env.url}/api/data/v9.2/WhoAmI`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!probe.ok) {
      console.log(`\n(skipping ${env.name}: WhoAmI failed ${probe.status})`);
      continue;
    }
    console.log(`\n=== env: ${env.name} (${env.url}) ===`);
    for (const table of TABLES) {
      const url =
        `${env.url}/api/data/v9.2/EntityDefinitions(LogicalName='${table}')` +
        `?$select=LogicalName,DisplayName,IsCustomizable,IsPrivate,IsManaged,IsIntersect,OwnershipType,IsValidForAdvancedFind,DataProviderId,EntitySetName`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
      });
      if (!res.ok) {
        console.log(`  ${table}: lookup failed (${res.status}) ${(await res.text()).slice(0, 300)}`);
        continue;
      }
      const json = (await res.json()) as Record<string, unknown>;
      console.log(`  ${table}:`);
      console.log(`    IsCustomizable: ${JSON.stringify(json.IsCustomizable)}`);
      console.log(`    IsPrivate: ${json.IsPrivate}`);
      console.log(`    IsManaged: ${json.IsManaged}`);
      console.log(`    IsIntersect: ${json.IsIntersect}`);
      console.log(`    OwnershipType: ${json.OwnershipType}`);
      console.log(`    IsValidForAdvancedFind: ${JSON.stringify(json.IsValidForAdvancedFind)}`);
      console.log(`    DataProviderId: ${json.DataProviderId}`);
      console.log(`    EntitySetName: ${json.EntitySetName}`);

      if (json.EntitySetName) {
        const dataRes = await fetch(`${env.url}/api/data/v9.2/${json.EntitySetName}?$top=1`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
        });
        console.log(`    Live GET ${json.EntitySetName}?$top=1 -> ${dataRes.status}`);
        if (!dataRes.ok) {
          console.log(`      ${(await dataRes.text()).slice(0, 400)}`);
        } else {
          const body = (await dataRes.json()) as { value?: unknown[] };
          console.log(`      rows returned: ${(body.value ?? []).length}`);
        }
      }
    }
    break; // first reachable env is enough — this is platform metadata, not per-env data
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
