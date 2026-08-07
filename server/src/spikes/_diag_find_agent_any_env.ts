/** Find a Copilot agent by name across ALL cached environments, and dump its
 *  knowledge sources + topics. The cached session points at one environment only,
 *  which is not necessarily the DEFAULT one.
 *  npx tsx src/spikes/_diag_find_agent_any_env.ts "agent name" */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

const WANTED = (process.argv[2] ?? 'cloudfuze studio migrate').toLowerCase();
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const tenant = s?.tenantId;
if (!tenant) { console.error('no tenant in session'); process.exit(1); }

const cache = await getDb().collection('environmentsCache').find({}).limit(1).next() as any;
const envs: Array<{ name?: string; displayName?: string; url?: string; orgUrl?: string }> = cache?.envs ?? cache?.environments ?? [];
console.log(`searching ${envs.length} environment(s) for "${WANTED}"\n`);

for (const env of envs) {
  const url = env.url ?? env.orgUrl;
  const name = env.name ?? env.displayName;
  if (!url) continue;
  let bots;
  try {
    const token = await clientCredsToken(tenant, url);
    bots = await listBots(url, token);
  } catch (e) {
    console.log(`  ${name}: ERROR ${(e as Error).message.slice(0, 90)}`);
    continue;
  }
  const hit = bots.filter((b) => b.name.toLowerCase().includes(WANTED));
  console.log(`  ${name} (${bots.length} agents)${hit.length ? '  <<< MATCH' : ''}`);
  for (const h of hit) {
    console.log(`     ${h.name}  [${h.botid}]`);
    const token = await clientCredsToken(tenant, url);
    const ir = await extractAgent(url, token, h);
    console.log(`\n     knowledge sources: ${ir.knowledgeSources.length}`);
    for (const ks of ir.knowledgeSources) {
      console.log(`       ── ${ks.name}  [${ks.kind}]`);
      if (ks.reference) console.log(`          reference : ${ks.reference}`);
      if (ks.references?.length) console.log(`          references: ${ks.references.join(' | ')}`);
      if (ks.classification) console.log(`          strategy  : ${ks.classification.strategy} -> ${ks.classification.geminiTarget}`);
    }
    const custom = ir.topics.filter((t) => !t.isSystem);
    console.log(`\n     topics: ${ir.topics.length} total, ${custom.length} custom`);
    for (const t of custom) console.log(`       - ${t.name}${t.aiPrompt ? '  [AI prompt]' : ''}`);
  }
}
process.exit(0);
