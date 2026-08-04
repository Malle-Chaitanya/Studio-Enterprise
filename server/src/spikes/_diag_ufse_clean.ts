/** Clean, unfiltered check of unstructuredfilesearchentities/records — official Dataverse tables per Microsoft Learn. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');

  for (const env of s.environments ?? []) {
    if (env.name !== 'CloudFuze Migration Test') continue;
    const token = await clientCredsToken(s.tenantId ?? '', env.url);

    for (const set of ['unstructuredfilesearchentities', 'unstructuredfilesearchrecords']) {
      console.log(`\n=== ${set} ===`);
      const res = await dvGet(env.url, token, `${set}?$select=name&$top=5`);
      console.log(`status: ${res.status}`);
      console.log(res.text.slice(0, 600));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
