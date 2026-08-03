/**
 * Dump the FULL raw `data` (YAML) blob for componenttype-16 (KnowledgeSource)
 * records — the extraction diagnostic showed "vv.docx"/"daily_queries.txt"
 * resolving to kind="KnowledgeSourceConfiguration" via parseKnowledgeSource
 * (which reads c.data, not c.content) — meaning they're type-16 rows, not
 * type-14. This dumps the real YAML so the classifier can be fixed against
 * ground truth instead of guessing.
 *
 *   npx tsx src/spikes/_diag_raw_ks16.ts ["name substring"] [sessionId]
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
        `botcomponents?$select=name,data,content&$filter=statecode eq 0 and componenttype eq 16&$top=200`,
      )).value;
    } catch (e) {
      console.log(`[${env.name}] failed — ${(e as Error).message}`);
      continue;
    }

    for (const c of comps) {
      const name = String(c.name ?? '');
      if (NAME_FILTER && !name.toLowerCase().includes(NAME_FILTER)) continue;
      console.log(`\n=== ${env.name} :: "${name}" ===`);
      console.log('--- data ---');
      console.log(c.data ?? '(null)');
      console.log('--- content ---');
      console.log(c.content ?? '(null)');
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
