/**
 * Read-only: for a set of named Bot File Attachments (componenttype 14),
 * dump every column Dataverse will give us to check whether the record
 * carries any provenance signal (a SharePoint/OneDrive source URL, a sync
 * marker) that would distinguish "synced from SharePoint" from "manually
 * uploaded" — or confirm that no such signal exists, which is the claim
 * this diagnostic is checking.
 *
 *   npx tsx src/_diag_file_origin.ts ["name substring"] [sessionId]
 *
 * Touches Copilot Studio READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { clientCredsToken } from './auth/microsoft.js';

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

    // Pull ALL columns (no $select) for componenttype 14 so nothing is
    // filtered out before we've looked for a provenance field.
    let comps;
    try {
      comps = (await dvGet(
        env.url,
        token,
        `botcomponents?$filter=statecode eq 0 and componenttype eq 14&$top=200`,
      )).value;
    } catch (e) {
      console.log(`[${env.name}] failed — ${(e as Error).message}`);
      continue;
    }

    for (const c of comps) {
      const name = String(c.filedata_name ?? c.name ?? '');
      if (NAME_FILTER && !name.toLowerCase().includes(NAME_FILTER)) continue;
      console.log(`\n=== ${env.name} :: "${name}" ===`);
      // Print every column EXCEPT the actual annotation/odata bulk noise and
      // the raw file bytes column, so this stays readable.
      for (const [k, v] of Object.entries(c)) {
        if (/^@odata/.test(k)) continue;
        const val = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v;
        console.log(`  ${k}: ${JSON.stringify(val)}`);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
