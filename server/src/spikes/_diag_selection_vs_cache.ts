/**
 * Why does the Connectors screen show a surface choice for SOME selected agents and not
 * others? The screen sends (envUrl, sourceIds) and the server looks each one up in the IR
 * cache keyed by BOTH. A mismatch on either key drops the agent silently — no error, just a
 * missing decision, which is the failure mode this whole screen must not have.
 *
 * Prints the three things that have to line up: the plan's selection, the cache's keys, and
 * the intersection the route would actually compute.
 *
 *   cd server && npx tsx src/spikes/_diag_selection_vs_cache.ts
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
  | { appUserId?: string; sessionId?: string; _id?: unknown; plan?: { units?: Array<{ envUrl: string; envName?: string; bots?: Array<{ botid: string; name?: string }> }> } }
  | null;
const appUserId = s?.appUserId ?? '';
console.log(`appUserId : ${appUserId}`);
console.log(`session   : ${String((s as { _id?: unknown })?._id ?? s?.sessionId ?? '?')}\n`);

console.log('--- PLAN (what the screen will ask about) ---');
const units = s?.plan?.units ?? [];
if (!units.length) console.log('  (no plan units — the screen has nothing to render)');
for (const u of units) {
  console.log(`  env ${u.envUrl}  (${u.envName ?? '?'})`);
  for (const b of u.bots ?? []) console.log(`      ${b.botid}  ${b.name ?? ''}`);
}

console.log('\n--- CACHE (what the server can answer about) ---');
const rows = await db.collection('agentIRCache').find({ appUserId }).toArray();
for (const r of rows) {
  const ir = (r as { ir?: { name?: string } }).ir;
  console.log(`  env ${(r as { envUrl?: string }).envUrl}  ${(r as { sourceId?: string }).sourceId}  ${ir?.name ?? ''}`);
}

console.log('\n--- WHAT THE ROUTE WOULD RETURN, per env ---');
for (const u of units) {
  const ids = (u.bots ?? []).map((b) => b.botid);
  console.log(`  env ${u.envUrl}  ${ids.length} selected id(s)`);
  for (const id of ids) {
    const entry = await getCachedIR(appUserId, u.envUrl, id);
    if (!entry) { console.log(`      MISS  ${id}  no cached IR under this envUrl`); continue; }
    const conn = agentConnectorIds(entry.ir);
    const hits = Object.keys(SURFACE_EQUIVALENTS).filter((k) => conn.has(k));
    console.log(
      hits.length
        ? `      OFFER ${entry.ir.name} -> ${hits.join(', ')}`
        : `      none  ${entry.ir.name} (connectors: ${[...conn].join(', ') || 'none'})`,
    );
  }
}
process.exit(0);
