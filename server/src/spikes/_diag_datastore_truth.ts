/**
 * Which data stores are REALLY unreferenced?
 *
 * My earlier count ("36 of 42 attached to no engine") was the wrong question and would have
 * justified a destructive cleanup. An ADK-migrated agent grounds through `groundingDataStores`
 * resource paths baked INTO its Reasoning Engine — it never appears in `engine.dataStoreIds`.
 * So "not attached to an engine" is the NORMAL state for exactly the stores that matter, and
 * deleting on that signal would silently un-ground live migrated agents.
 *
 * Three sources of truth, printed per store:
 *   1. engine.dataStoreIds        — the low-code path
 *   2. adkKnowledgeStores         — our own record of stores grounded onto ADK agents
 *   3. knowledgeConnectors        — connector-backed stores we created
 * A store none of the three claims is a genuine candidate. Nothing is deleted here.
 *
 *   cd server && npx tsx src/spikes/_diag_datastore_truth.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const PARENT = `projects/${PROJECT}/locations/global/collections/default_collection`;
await connectMongo();
const db = getDb();
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
const get = async (u: string) => {
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  return { ok: r.ok, status: r.status, body: (await r.json()) as Record<string, any> };
};

const eng = await get(`https://discoveryengine.googleapis.com/v1alpha/${PARENT}/engines?pageSize=100`);
const inEngine = new Set<string>();
for (const e of (eng.body.engines ?? []) as Array<Record<string, any>>) {
  for (const id of (e.dataStoreIds ?? []) as string[]) inEngine.add(id);
}

// Our own records. Field names vary by repo, so scan the whole document for the store id
// rather than guessing a key and reporting a false "unreferenced".
const recorded = new Map<string, string[]>();
for (const coll of ['adkKnowledgeStores', 'knowledgeConnectors', 'pendingGroundingRechecks', 'migrationResults']) {
  const rows = (await db.collection(coll).find({}).toArray()) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const blob = JSON.stringify(r);
    const hits = blob.match(/dataStores\/([A-Za-z0-9_\-]+)/g) ?? [];
    for (const h of hits) {
      const id = h.split('/')[1];
      recorded.set(id, [...(recorded.get(id) ?? []), coll]);
    }
    // Stores are also recorded as a bare id in some rows.
    for (const key of ['dataStoreId', 'storeId']) {
      const v = (r as Record<string, unknown>)[key];
      if (typeof v === 'string') recorded.set(v, [...(recorded.get(v) ?? []), coll]);
    }
  }
}

let page = '';
const rows: Array<{ id: string; claimedBy: string[] }> = [];
do {
  const r = await get(`https://discoveryengine.googleapis.com/v1alpha/${PARENT}/dataStores?pageSize=100${page ? `&pageToken=${page}` : ''}`);
  if (!r.ok) break;
  for (const ds of (r.body.dataStores ?? []) as Array<Record<string, any>>) {
    const id = String(ds.name).split('/').pop()!;
    const claimedBy = [...(inEngine.has(id) ? ['engine.dataStoreIds'] : []), ...new Set(recorded.get(id) ?? [])];
    rows.push({ id, claimedBy });
  }
  page = String(r.body.nextPageToken ?? '');
} while (page);

const unclaimed = rows.filter((r) => !r.claimedBy.length);
console.log(`${rows.length} data store(s): ${rows.length - unclaimed.length} claimed, ${unclaimed.length} claimed by NOTHING\n`);
for (const r of rows.filter((x) => x.claimedBy.length)) console.log(`  CLAIMED    ${r.id}   <- ${r.claimedBy.join(', ')}`);
console.log('');
for (const r of unclaimed) console.log(`  unclaimed  ${r.id}`);
console.log('\nUnclaimed is a CANDIDATE list, not a delete list: a store grounded onto an engine');
console.log('whose record predates adkKnowledgeStores would also look unclaimed here.');
process.exit(0);
