/**
 * `documents_regional` quota exceeded during a live run (2026-08-21). The limit cannot be read
 * — Cloud Quotas API is disabled on this project — so measure the CONSUMPTION instead: every
 * data store in the project and how many documents it holds. A stale store from an old run
 * costs the same quota as a live one, which makes this a cleanup question, not a Google one.
 *
 *   cd server && npx tsx src/spikes/_diag_document_quota_usage.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const PARENT = `projects/${PROJECT}/locations/global/collections/default_collection`;
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);

async function get(url: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { ok: r.ok, status: r.status, body: (await r.json()) as Record<string, unknown> };
}

// Which stores are actually attached to an engine? An unattached store is pure quota cost.
const eng = await get(`https://discoveryengine.googleapis.com/v1alpha/${PARENT}/engines?pageSize=100`);
const attached = new Set<string>();
for (const e of (eng.body.engines ?? []) as Array<Record<string, unknown>>) {
  for (const id of (e.dataStoreIds ?? []) as string[]) attached.add(id);
}

let page = '';
const stores: Array<{ id: string; docs: number | string; attached: boolean; created: string }> = [];
do {
  const r = await get(`https://discoveryengine.googleapis.com/v1alpha/${PARENT}/dataStores?pageSize=100${page ? `&pageToken=${page}` : ''}`);
  if (!r.ok) { console.log(`dataStores -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); break; }
  for (const ds of (r.body.dataStores ?? []) as Array<Record<string, unknown>>) {
    const id = String(ds.name).split('/').pop()!;
    // Documents live under the default branch; ask for one page and read the total if given.
    const d = await get(
      `https://discoveryengine.googleapis.com/v1alpha/${String(ds.name)}/branches/default_branch/documents?pageSize=1`,
    );
    const docs = d.ok ? (d.body.totalSize !== undefined ? Number(d.body.totalSize) : ((d.body.documents ?? []) as unknown[]).length ? '>=1' : 0) : `err${d.status}`;
    stores.push({ id, docs, attached: attached.has(id), created: String(ds.createTime ?? '?').slice(0, 10) });
  }
  page = String(r.body.nextPageToken ?? '');
} while (page);

stores.sort((a, b) => Number(b.docs === '>=1' ? 1 : b.docs || 0) - Number(a.docs === '>=1' ? 1 : a.docs || 0));
console.log(`${stores.length} data store(s); ${stores.filter((s) => !s.attached).length} attached to NO engine\n`);
for (const s of stores) {
  console.log(`  ${String(s.docs).padStart(6)} docs  ${s.attached ? 'attached' : 'ORPHAN  '}  ${s.created}  ${s.id}`);
}
process.exit(0);
