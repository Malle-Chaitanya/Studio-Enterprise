/**
 * Investigate what a `skillConfiguration` name (e.g. "vvdocx_YQfh2eBbMADnjFCIY2jKV")
 * actually resolves to. Lists every Dataverse table whose logical/display name
 * hints at "skill", "search", "connector", "richtext", "generative", or
 * "knowledge" — candidates for where SharePoint/OneDrive file-picker
 * knowledge sources might store their real target (a file id, a URL, or a
 * Graph connector reference).
 *
 *   npx tsx src/spikes/_diag_find_skill_table.ts [sessionId]
 *
 * Touches Copilot Studio READ-ONLY (metadata queries only) — creates/changes
 * nothing.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const SESSION_ID = process.argv[2];

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

const KEYWORDS = /skill|search|connector|richtext|generative|knowledge|federat/i;

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
    console.log(`\n=== ${env.name} (${env.url}) ===`);
    let defs;
    try {
      defs = (await dvGet(
        env.url,
        token,
        `EntityDefinitions?$select=LogicalName,EntitySetName,DisplayName`,
      )).value;
    } catch (e) {
      console.log(`  EntityDefinitions failed: ${(e as Error).message}`);
      continue;
    }
    const candidates = defs.filter((d) => KEYWORDS.test(String(d.LogicalName ?? '')));
    console.log(`  ${defs.length} total tables, ${candidates.length} keyword matches:`);
    for (const c of candidates) {
      console.log(`    - ${c.LogicalName}  (set: ${c.EntitySetName})`);
    }
    break; // only need this once — same solution schema across environments
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
