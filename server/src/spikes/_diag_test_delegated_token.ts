import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { delegatedDataverseToken } from '../auth/microsoft.js';

const TABLES = ['unstructuredfilesearchentities', 'unstructuredfilesearchrecords'];

async function main() {
  await connectMongo();
  // Bypass getSession's TTL check — we only need the stored refreshToken, the
  // session itself doesn't need to be "live" for this test.
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
    | (Session & { _id?: string })
    | null;
  if (!s) throw new Error('no session doc found');
  console.log(`session appUserId=${s.appUserId} tenantId=${s.tenantId}`);
  console.log(`has refreshToken: ${!!s.refreshToken}`);
  if (!s.refreshToken) throw new Error('no refreshToken stored on the latest session — cannot test delegated auth');

  for (const env of s.environments ?? []) {
    console.log(`\n=== trying env ${env.name} (${env.url}) ===`);
    const result = await delegatedDataverseToken(s.tenantId ?? '', s.refreshToken, env.url);
    if (!result) {
      console.log('  delegatedDataverseToken exchange failed (see warn log above)');
      continue;
    }
    console.log('  got delegated token, testing blocked tables...');
    for (const table of TABLES) {
      const res = await fetch(`${env.url}/api/data/v9.2/${table}?$top=1`, {
        headers: {
          Authorization: `Bearer ${result.token}`,
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
        },
      });
      console.log(`  GET ${table}?$top=1 -> ${res.status}`);
      if (!res.ok) {
        console.log(`    ${(await res.text()).slice(0, 400)}`);
      } else {
        const body = (await res.json()) as { value?: unknown[] };
        console.log(`    SUCCESS — rows returned: ${(body.value ?? []).length}`);
        console.log(`    ${JSON.stringify(body.value?.[0] ?? {}, null, 2)}`);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
