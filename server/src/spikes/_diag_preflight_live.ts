/**
 * Run the SHIPPED pre-flight gate against a real agent's real connectors.
 *
 * The unit tests prove the logic with mocked HTTP. This proves it against the live project,
 * live Secret Manager IAM and live providers — which is the only way to know the gate would
 * have caught (or cleared) an actual migration.
 *
 *   cd server && npx tsx src/spikes/_diag_preflight_live.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { preflightConnectors } from '../services/connectorPreflight.js';
import { resolveProjectNumber } from '../services/adkDeployer.js';

await connectMongo();
const db = getDb();
// SESSION-OPTIONAL, deliberately. `migrationSessions` has a Mongo TTL, so a few hours after
// the browser was last used this spike reported "no connectors configured" — which reads as a
// setup problem and is really just an expired row. The credential records survive, and they
// carry both the owner scope and the project, so they are the better source for a diagnostic
// that has to work at any hour.
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { appUserId?: string; geminiProject?: string } | null;
const anyCred = (await db.collection('connectorCredentials').findOne({})) as
  | { appUserId?: string; project?: string } | null;
const appUserId = s?.appUserId ?? anyCred?.appUserId ?? 'default';
const project = s?.geminiProject ?? anyCred?.project ?? process.env.GEMINI_PROJECT_FALLBACK ?? '';
if (!project) {
  console.log('no project: no session, no credential record and no GEMINI_PROJECT_FALLBACK');
  process.exit(1);
}
console.log(`source: ${s ? 'live session' : 'credential records (no session — TTL expired)'}`);
const saToken = await getSaToken();
const projectNumber = await resolveProjectNumber(project, saToken);
console.log(`project ${project} (${projectNumber})\n`);

const saved = await listConnectorCredentials(appUserId);
const targets = saved.map((c) => ({
  connectorId: c.connectorId,
  name: REGISTRY_BY_ID.get(c.connectorId)?.name ?? c.connectorId,
  secretIds: c.secretIds ?? {},
}));

const checks = await preflightConnectors(saToken, project, projectNumber!, targets);
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.slice(0, 40).padEnd(41)} ${c.validation ?? ''}`);
  if (!c.ok) console.log(`        ${c.blocker}: ${c.detail?.slice(0, 150)}`);
}
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} connector(s) would work once deployed`);
process.exit(0);
