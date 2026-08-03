/**
 * Dump the FULL, unabridged `content` column for named componenttype-14
 * records — used to work out the real nested $kind shape for SharePoint/
 * OneDrive file sources, which turned out to differ from the Dataverse-table
 * case (isEmbeddedConfigSource in dataverse.ts currently reads the wrong
 * nesting level for these).
 *
 *   npx tsx src/spikes/_diag_raw_content.ts ["name substring"] [sessionId]
 *
 * Touches Copilot Studio READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const NAME_FILTER = (process.argv[2] || '').toLowerCase();
const SESSION_ID = process.argv[3];

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');

  for (const env of s.environments ?? []) {
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    let comps;
    try {
      comps = (await dvGet(
        env.url,
        token,
        `botcomponents?$select=name,filedata_name,content&$filter=statecode eq 0 and componenttype eq 14&$top=200`,
      )).value;
    } catch (e) {
      console.log(`[${env.name}] failed — ${(e as Error).message}`);
      continue;
    }

    for (const c of comps) {
      const name = String(c.filedata_name ?? c.name ?? '');
      if (NAME_FILTER && !name.toLowerCase().includes(NAME_FILTER)) continue;
      if (!c.content) continue;
      console.log(`\n=== ${env.name} :: "${name}" ===`);
      try {
        console.log(JSON.stringify(JSON.parse(String(c.content)), null, 2));
      } catch {
        console.log(String(c.content));
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
