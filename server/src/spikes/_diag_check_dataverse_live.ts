/** Live app-only Dataverse check — mints a fresh client_credentials token (no
 *  stored token reused) and calls WhoAmI against each accessible org from the
 *  most recent environmentsCache entry. Read-only.
 *  npx tsx src/spikes/_diag_check_dataverse_live.ts */
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
  const row = (await getDb()
    .collection<EnvCacheRow>('environmentsCache')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next());
  if (!row) throw new Error('no environmentsCache entry');

  const targets = row.environments.filter((e) => e.accessible);
  console.log(`tenant ${row.tenantId} — ${targets.length} previously-accessible org(s) to re-check live\n`);

  for (const env of targets) {
    try {
      const token = await clientCredsToken(row.tenantId, env.url);
      const res = await fetch(`${env.url}/api/data/v9.2/WhoAmI`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const body = await res.text();
      console.log(`${env.name.padEnd(30)} ${env.url}`);
      console.log(`  status=${res.status}  ${body.slice(0, 200)}`);
    } catch (e) {
      console.log(`${env.name.padEnd(30)} ${env.url}`);
      console.log(`  ERROR: ${(e as Error).message}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
