/**
 * Would the surface-choice screen actually OFFER a choice for these agents?
 *
 * The screen reads the CACHED IR (`getCachedIR`) and asks `agentConnectorIds` which
 * connectors the agent uses. If the cache has no entry — never explored, or explored under a
 * different envUrl — the agent silently does not appear and the screen looks empty rather
 * than broken. That is a hard failure to diagnose from the browser, and trivial from here.
 *
 *   cd server && npx tsx src/spikes/_diag_ir_cache_surface.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import { SURFACE_EQUIVALENTS } from '../db/repos/agentSurfaceChoice.js';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { appUserId?: string } | null;
const appUserId = s?.appUserId ?? '';
console.log(`appUserId: ${appUserId}\n`);

const rows = await db.collection('agentIRCache')
  .find({ appUserId }).sort({ $natural: -1 }).limit(40).toArray();
console.log(`${rows.length} cached IR entr(ies) for this user\n`);

let offered = 0;
for (const r of rows) {
  const envUrl = String(r.envUrl ?? '');
  const sourceId = String(r.sourceId ?? '');
  const cached = await getCachedIR(appUserId, envUrl, sourceId);
  if (!cached) { console.log(`  MISS  ${sourceId.slice(0, 8)}  (row exists but getCachedIR returned nothing)`); continue; }
  const ids = agentConnectorIds(cached.ir);
  const surfaces = Object.keys(SURFACE_EQUIVALENTS).filter((k) => ids.has(k));
  if (surfaces.length) {
    offered++;
    console.log(`  OFFERS  "${cached.ir.name}"  -> ${surfaces.join(', ')}`);
  }
}
console.log(`\n${offered} agent(s) would be offered a surface choice.`);
if (!offered) {
  console.log('If the agent you expect is missing, its IR is not cached under this envUrl —');
  console.log('re-run Explore in the UI for that environment before the Connectors screen.');
}
process.exit(0);
