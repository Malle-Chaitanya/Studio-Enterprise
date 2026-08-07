/**
 * Read one Copilot Studio agent's knowledge sources — specifically to pull out the
 * SharePoint LINK it points at, so we can index exactly that URL as a connector's
 * instance_uri instead of crawling the whole tenant.
 *
 * Scope matters: a tenant-wide SharePoint connector exposed 99 sites in this tenant.
 * A source agent that names one site or folder should produce a connector scoped to
 * that path and nothing more.
 *
 * Read-only. Needs Mongo up (for the cached session's tenant + environment URL).
 *
 * npx tsx src/spikes/_diag_copilot_agent_knowledge.ts ["Agent Name"]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

const WANTED = (process.argv[2] ?? 'CloudFuze Studio Migrate').toLowerCase();

await connectMongo();
const session = (await getDb()
  .collection('migrationSessions')
  .find({ dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;

if (!session?.dvOrgUrl || !session.tenantId) {
  console.error('No cached session with dvOrgUrl/tenantId. Connect Microsoft in the app once, then re-run.');
  process.exit(1);
}
console.log(`env    : ${session.dvOrgUrl}`);
console.log(`tenant : ${session.tenantId}\n`);

const token = await clientCredsToken(session.tenantId, session.dvOrgUrl);
const bots = await listBots(session.dvOrgUrl, token);
console.log(`${bots.length} agent(s) in this environment`);

const match = bots.find((b) => b.name.toLowerCase().includes(WANTED));
if (!match) {
  console.log(`\nNo agent matching "${WANTED}". Available:`);
  for (const b of bots.slice(0, 25)) console.log(`  - ${b.name}`);
  process.exit(0);
}

console.log(`\n═══ ${match.name} (${match.botid}) ═══`);
const ir = await extractAgent(session.dvOrgUrl, token, match);

console.log(`\nknowledge sources: ${ir.knowledgeSources.length}`);
for (const ks of ir.knowledgeSources) {
  console.log(`\n  ── ${ks.name}`);
  console.log(`     kind          : ${ks.kind}`);
  if (ks.reference) console.log(`     reference     : ${ks.reference}`);
  if (ks.references?.length) console.log(`     references    : ${ks.references.join(' | ')}`);
  if (ks.confluenceSpaceNames?.length) console.log(`     confluence    : ${ks.confluenceSpaceNames.join(', ')}`);
  if (ks.file?.name) console.log(`     file          : ${ks.file.name}`);
  if (ks.classification) {
    console.log(`     strategy      : ${ks.classification.strategy}`);
    console.log(`     geminiTarget  : ${ks.classification.geminiTarget}`);
  }
  // The SharePoint URL is what we would hand a connector as instance_uri.
  const urls = [ks.reference, ...(ks.references ?? [])].filter(
    (u): u is string => !!u && /sharepoint\.com|\/sites\/|onedrive/i.test(u),
  );
  if (urls.length) console.log(`     >>> SharePoint URL(s) to index: ${urls.join(' , ')}`);
}

// Topics, for the sub-agent question — how many domains would become sub-agents.
const custom = ir.topics.filter((t) => !t.isSystem);
console.log(`\ntopics: ${ir.topics.length} total, ${custom.length} custom (system topics excluded)`);
for (const t of custom.slice(0, 15)) {
  console.log(`  - ${t.name}${t.aiPrompt ? '  [has AI Builder prompt]' : ''}`);
}
process.exit(0);
