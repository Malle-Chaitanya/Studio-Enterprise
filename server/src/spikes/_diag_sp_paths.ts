/**
 * For every SharePoint knowledge source in the tenant: which migration path will it take?
 *
 * The orchestrator tries COPY MODE first (Graph download -> document data store, proven
 * live 2026-08-07) and only falls back to Gemini's native connector when the URL is
 * genuinely ambiguous. So "is SharePoint ready" is really "how many sources resolve to a
 * single file". Answer it with the same resolver the migration uses, not by guessing from
 * the URL string.
 *
 * Read-only: resolves and inspects, downloads nothing.
 *
 * npx tsx src/spikes/_diag_sp_paths.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { resolveShareUrlSmart } from '../services/graphFiles.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;
const graphToken = await clientCredsToken(tenantId, 'https://graph.microsoft.com');

let copy = 0;
let fallback = 0;
for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try { token = await clientCredsToken(tenantId, env.url); bots = await listBots(env.url, token); } catch { continue; }
  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    for (const k of ir.knowledgeSources ?? []) {
      const blob = JSON.stringify(k);
      if (!/sharepoint/i.test(blob)) continue;
      const url = /"(https:\/\/[^"]*sharepoint[^"]*)"/i.exec(blob)?.[1];
      if (!url) {
        fallback++;
        console.log(`  FALLBACK  ${ir.name} :: ${k.name} — no URL captured on the source`);
        continue;
      }
      let kind = 'error';
      let item = '';
      try {
        const r = await resolveShareUrlSmart(graphToken, url);
        kind = r.kind;
        item = r.item?.name ?? (r.candidates?.length ? `${r.candidates.length} candidates` : '');
      } catch (e) {
        item = (e as Error).message.slice(0, 60);
      }
      const copyable = kind === 'file' || kind === 'folder-single-file';
      if (copyable) copy++; else fallback++;
      console.log(`  ${copyable ? 'COPY MODE' : 'FALLBACK '} ${ir.name} :: ${k.name}`);
      console.log(`            kind=${kind} ${item}`);
    }
  }
}
console.log(`\n${copy} source(s) take the proven copy-mode path · ${fallback} fall back to the native connector`);
process.exit(0);
