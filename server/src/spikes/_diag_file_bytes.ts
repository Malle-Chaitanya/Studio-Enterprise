/**
 * Read-only: fetch the Dataverse bytes for a named Bot File Attachment and
 * report size/content-type/success — isolates whether a failed file-upload
 * is failing at the Dataverse-fetch step or the Gemini-upload step (which
 * currently returns an error string that the orchestrator's attachKnowledgeFiles
 * silently drops without logging — a real observability gap, separate from
 * whatever the root cause turns out to be).
 *
 *   npx tsx src/spikes/_diag_file_bytes.ts ["name substring"] [sessionId]
 *
 * Touches Copilot Studio READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { fetchFileAttachmentBytes } from '../services/dataverse.js';

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
        `botcomponents?$select=botcomponentid,name,filedata_name,filedata&$filter=statecode eq 0 and componenttype eq 14&$top=200`,
      )).value;
    } catch {
      continue;
    }

    for (const c of comps) {
      const name = String(c.filedata_name ?? c.name ?? '');
      if (NAME_FILTER && !name.toLowerCase().includes(NAME_FILTER)) continue;
      console.log(`\n=== ${env.name} :: "${name}" (id=${c.botcomponentid}) ===`);
      console.log(`  filedata column present: ${c.filedata ? 'yes' : 'NO (null)'}`);
      const got = await fetchFileAttachmentBytes(env.url, token, String(c.botcomponentid));
      if (!got) {
        console.log('  fetchFileAttachmentBytes → FAILED (returned null — see server log for the actual HTTP status)');
      } else {
        console.log(`  fetchFileAttachmentBytes → OK: ${got.bytes.length} bytes, contentType="${got.contentType}"`);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
