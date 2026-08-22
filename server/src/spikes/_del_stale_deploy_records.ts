/**
 * DESTRUCTIVE (Mongo). Removes the adkDeployments records that point at agent ids deleted from
 * Gemini on 2026-08-21, so the five-agent run is a silent clean create instead of a recreate
 * with a resync note.
 *
 * Deletes by _id, never by a broad filter, and only for ids this script can prove are 404 in
 * the destination RIGHT NOW — a record whose agent still exists is a live deployment and
 * deleting it would mint a second billable Reasoning Engine on the next run. Every record is
 * dumped to disk first, because Mongo has no undo.
 *
 *   cd server && npx tsx src/spikes/_del_stale_deploy_records.ts <dumpFile>        # dry run
 *   cd server && npx tsx src/spikes/_del_stale_deploy_records.ts <dumpFile> --go   # delete
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;
const SOURCE_PREFIXES = ['bdf9b817', '9b97b5fc', '45d6b647', '442c7099', '87aaf041'];

const dumpFile = process.argv[2];
const GO = process.argv.includes('--go');
if (!dumpFile) throw new Error('usage: _del_stale_deploy_records.ts <dumpFile> [--go]');

await connectMongo();
const db = getDb();
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);

const alive = new Map<string, boolean>();
async function stillThere(agentId: string) {
  if (!alive.has(agentId)) {
    const r = await fetch(`${BASE}/${agentId}`, { headers: { Authorization: `Bearer ${token}` } });
    alive.set(agentId, r.ok);
  }
  return alive.get(agentId)!;
}

const doomed: Array<{ coll: string; doc: Record<string, unknown> }> = [];
for (const coll of ['adkDeployments', 'migratedAgentSnapshots']) {
  const rows = (await db.collection(coll).find({}).toArray()) as Array<Record<string, unknown>>;
  for (const doc of rows) {
    const blob = JSON.stringify(doc);
    if (!SOURCE_PREFIXES.some((p) => blob.includes(p))) continue;
    const agentId = String(doc.agentId ?? '');
    // A snapshot carries no agentId; it is keyed by sourceId, so it rides along with the
    // deployment record it describes rather than being probed on its own.
    if (agentId && (await stillThere(agentId))) {
      console.log(`KEEP   ${coll}  agentId=${agentId} is STILL LIVE in Gemini`);
      continue;
    }
    doomed.push({ coll, doc });
    console.log(`${GO ? 'DELETE' : 'WOULD '} ${coll.padEnd(22)} _id=${String(doc._id)} agentId=${agentId || '-'} appUserId=${String(doc.appUserId)} source=${String(doc.sourceId ?? '?').slice(0, 8)}`);
  }
}

writeFileSync(dumpFile, JSON.stringify(doomed, null, 1), 'utf8');
console.log(`\n${doomed.length} record(s); dumped to ${dumpFile}`);

if (!GO) {
  console.log('dry run — pass --go to delete');
  process.exit(0);
}
for (const { coll, doc } of doomed) {
  const r = await db.collection(coll).deleteOne({ _id: doc._id as never });
  console.log(`  ${coll} ${String(doc._id)} -> deleted=${r.deletedCount}`);
}
console.log('done');
process.exit(0);
