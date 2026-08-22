/**
 * Why does one connector keep asking for credentials while others stay saved?
 *
 * /connector-requirements only counts a stored credential as supplied when its recorded
 * `project` equals the CURRENT destination project. A record written under a different
 * project reads as "never configured" — the admin retypes it, and each retype writes another
 * secret version while the screen still asks next time.
 *
 *   cd server && npx tsx src/spikes/_diag_saved_creds.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { effectiveGeminiProject } from '../services/gemini.js';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { appUserId?: string; geminiProject?: string } | null;
const appUserId = s?.appUserId ?? '';
const destProject = effectiveGeminiProject(s?.geminiProject);
console.log(`session.geminiProject : ${s?.geminiProject}`);
console.log(`effective destProject : ${destProject}\n`);

const saved = await listConnectorCredentials(appUserId);
console.log(`${saved.length} stored credential record(s)\n`);
const rows = saved.map((c) => ({
  connector: REGISTRY_BY_ID.get(c.connectorId)?.name ?? c.connectorId,
  group: REGISTRY_BY_ID.get(c.connectorId)?.credentialGroup ?? '-',
  project: c.project,
  usable: c.project === destProject ? 'YES' : 'NO  <-- asks again',
  fields: (c.fields ?? []).join(','),
}));
for (const r of rows.sort((a, b) => a.usable.localeCompare(b.usable))) {
  console.log(`  ${r.usable.padEnd(18)} ${String(r.connector).slice(0, 34).padEnd(35)} group=${String(r.group).padEnd(10)} project=${r.project}`);
  console.log(`  ${''.padEnd(18)} fields: ${r.fields}`);
}
process.exit(0);
