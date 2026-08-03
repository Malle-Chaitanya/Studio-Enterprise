/**
 * Try to resolve a known skillConfiguration name (e.g. "vvdocx_YQfh2eBbMADnjFCIY2jKV")
 * against the most likely candidate Dataverse tables found via
 * _diag_find_skill_table.ts, to see which one (if any) actually stores it and
 * what it points to.
 *
 *   npx tsx src/spikes/_diag_resolve_skill.ts <skillConfigurationName> [sessionId]
 *
 * Touches Copilot Studio READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const NAME = process.argv[2];
const SESSION_ID = process.argv[3];
if (!NAME) throw new Error('usage: _diag_resolve_skill.ts <skillConfigurationName> [sessionId]');

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return { ok: res.ok, status: res.status, json: res.ok ? ((await res.json()) as { value?: Record<string, unknown>[] }) : null };
}

// Candidate entity sets + a plausible name/lookup column to filter on.
const CANDIDATES: { set: string; nameCols: string[] }[] = [
  { set: 'skills', nameCols: ['name', 'skillid'] },
  { set: 'federatedknowledgeconfigurations', nameCols: ['name'] },
  { set: 'federatedknowledgeentityconfigurations', nameCols: ['name'] },
  { set: 'unstructuredfilesearchrecords', nameCols: ['name'] },
  { set: 'unstructuredfilesearchentities', nameCols: ['name'] },
  { set: 'dvfilesearchs', nameCols: ['name'] },
  { set: 'msdyn_connectordatasources', nameCols: ['msdyn_name', 'name'] },
];

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
    if (env.name !== 'CloudFuze Migration Test') continue; // the one with real permission

    for (const c of CANDIDATES) {
      // Try each plausible name column with a startswith/eq filter.
      for (const col of c.nameCols) {
        const filter = `contains(${col},'${NAME.split('_')[0]}')`;
        const path = `${c.set}?$filter=${encodeURIComponent(filter)}&$top=5`;
        try {
          const res = await dvGet(env.url, token, path);
          if (!res.ok) {
            console.log(`${c.set}.${col}: HTTP ${res.status}`);
            continue;
          }
          const rows = res.json?.value ?? [];
          if (rows.length) {
            console.log(`\n=== MATCH in ${c.set} (filter ${col} contains "${NAME.split('_')[0]}") ===`);
            for (const r of rows) console.log(JSON.stringify(r, null, 2));
          } else {
            console.log(`${c.set}.${col}: 0 rows`);
          }
        } catch (e) {
          console.log(`${c.set}.${col}: ERROR ${(e as Error).message}`);
        }
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
