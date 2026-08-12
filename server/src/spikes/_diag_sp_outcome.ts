/**
 * For EVERY agent with SharePoint: what will it actually get after the fix?
 *
 * "Does this work for any agent" is not answerable from the two agents the fix was written
 * against. This replays the orchestrator's decision for every SharePoint source in the
 * tenant — recover the address if missing, resolve it through Graph, then apply the rule:
 * one file is STORED, anything broader is TOOL-SERVED. Anything that still ends with
 * neither is a remaining gap and is named.
 *
 * Read-only: resolves and recovers, downloads nothing, deploys nothing.
 *
 * npx tsx src/spikes/_diag_sp_outcome.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { resolveShareUrlSmart } from '../services/graphFiles.js';
import { recoverSharePointUrlAcrossEnvs } from '../services/sharePointUrlRecovery.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;
const graphToken = await clientCredsToken(tenantId, 'https://graph.microsoft.com');

// Recovery searches EVERY readable environment, the agent's own first — the address that
// one environment lost is often kept by an agent in another.
const allEnvs = await discoverEnvironments(tenantId);
async function recoveryEnvs(own: string) {
  const out: Array<{ envUrl: string; dvToken: string }> = [];
  for (const e of [own, ...allEnvs.map((x) => x.url).filter((u) => u !== own)]) {
    try { out.push({ envUrl: e, dvToken: await clientCredsToken(tenantId, e) }); } catch { /* skip */ }
  }
  return out;
}

const tally = new Map<string, number>();
const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);

for (const env of allEnvs) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try { token = await clientCredsToken(tenantId, env.url); bots = await listBots(env.url, token); } catch { continue; }
  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    const sps = (ir.knowledgeSources ?? []).filter((k) => k.kind !== 'FileUpload' && /sharepoint/i.test(JSON.stringify(k)));
    if (!sps.length) continue;
    console.log(`\n  ${ir.name}   [${env.name}]`);
    for (const k of sps) {
      let url = (k.reference ?? k.references?.[0] ?? '').trim();
      let via = '';
      if (!/^https?:\/\//i.test(url)) {
        const rec = await recoverSharePointUrlAcrossEnvs(await recoveryEnvs(env.url), k.name);
        if (rec.status === 'recovered') { url = rec.url; via = ' (address recovered)'; }
      }
      if (!/^https?:\/\//i.test(url)) {
        bump('NOTHING — no address');
        console.log(`      NOTHING     ${k.name} — no address stored and none recoverable`);
        continue;
      }
      let kind = 'error';
      try { kind = (await resolveShareUrlSmart(graphToken, url)).kind; } catch (e) { kind = `error: ${(e as Error).message.slice(0, 40)}`; }
      const outcome =
        kind === 'file' || kind === 'folder-single-file'
          ? 'STORED'
          : kind === 'folder-multiple-files'
            ? 'TOOLS'
            : 'TOOLS?';
      bump(outcome === 'TOOLS?' ? `TOOLS (unresolved: ${kind})` : outcome);
      console.log(`      ${outcome.padEnd(11)} ${k.name}${via}  [${kind}]`);
    }
  }
}

console.log(`\n${'─'.repeat(70)}`);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(2)}  ${k}`);
console.log('\nSTORED = fetched + indexed · TOOLS = live list/read scoped to that path');
process.exit(0);
