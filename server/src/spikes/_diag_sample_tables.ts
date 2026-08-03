/** Sample a few rows (no filter) from candidate tables to see their real shape. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const SETS = ['skills', 'federatedknowledgeconfigurations', 'unstructuredfilesearchrecords', 'dvfilesearchs'];

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
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    for (const set of SETS) {
      console.log(`\n=== ${set} ===`);
      const res = await dvGet(env.url, token, `${set}?$top=3`);
      if (!res.ok) {
        console.log(`  HTTP ${res.status}: ${res.text.slice(0, 300)}`);
        continue;
      }
      const json = JSON.parse(res.text) as { value?: Record<string, unknown>[] };
      if (!json.value?.length) {
        console.log('  (0 rows in this environment)');
        continue;
      }
      for (const row of json.value) console.log(JSON.stringify(row, null, 2));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
