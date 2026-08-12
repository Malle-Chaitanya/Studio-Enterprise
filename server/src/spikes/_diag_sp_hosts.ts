/**
 * Which HOST shape does each SharePoint source use?
 *
 * The deployed tools parse the scope URL themselves (_resolve_scope in adk_deploy.py).
 * A team-site URL and a personal OneDrive URL (`-my.sharepoint.com/personal/<user>`) are
 * different shapes, and resolving the second like the first points the tool at the wrong
 * site — silently, since Graph answers for the host either way.
 *
 * Read-only.  npx tsx src/spikes/_diag_sp_hosts.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { recoverSharePointUrlAcrossEnvs } from '../services/sharePointUrlRecovery.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;
const envs = await discoverEnvironments(tenantId);

for (const env of envs) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try { token = await clientCredsToken(tenantId, env.url); bots = await listBots(env.url, token); } catch { continue; }
  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    for (const k of ir.knowledgeSources ?? []) {
      if (k.kind === 'FileUpload' || !/sharepoint/i.test(JSON.stringify(k))) continue;
      let url = (k.reference ?? k.references?.[0] ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        const rec = await recoverSharePointUrlAcrossEnvs(
          [{ envUrl: env.url, dvToken: token }, ...envs.filter((e) => e.url !== env.url).map((e) => ({ envUrl: e.url, dvToken: token }))],
          k.name,
        );
        if (rec.status === 'recovered') url = rec.url;
      }
      if (!/^https?:\/\//i.test(url)) continue;
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const shape = /-my\.sharepoint\.com$/i.test(u.host)
        ? 'PERSONAL (-my)'
        : seg[0]?.toLowerCase() === 'sites'
          ? 'team site (/sites/...)'
          : 'root site';
      console.log(`  ${shape.padEnd(22)} ${ir.name} :: ${k.name}`);
      console.log(`      ${u.host}  segments=${JSON.stringify(seg)}`);
    }
  }
}
process.exit(0);
