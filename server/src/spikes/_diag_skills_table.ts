/** Re-check the "skills" Dataverse table properly — earlier query may have filtered wrong. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

async function main() {
  await connectMongo();
  const s = (await getDb()
    .collection('migrationSessions')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as Session | null;
  if (!s) throw new Error('no session');

  for (const env of s.environments ?? []) {
    if (env.name !== 'CloudFuze Migration Test') continue;
    const token = await clientCredsToken(s.tenantId ?? '', env.url);

    console.log('=== skills, unfiltered, $top=20 ===');
    const res = await fetch(`${env.url}/api/data/v9.2/skills?$top=20`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    console.log('status:', res.status);
    console.log((await res.text()).slice(0, 4000));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
