/** Full source-vs-destination validation for the "CF ICP Profile, FAQ Entry"
 * knowledge source on Migrate Advisor (sourceId bdf9b817-9b90-f111-b8da-0022480b1f83).
 * Pulls ALL rows from both real Dataverse tables (source) and both Discovery
 * Engine structured data stores (destination), matches by primary key, and
 * reports count parity + field-level diffs.
 *   npx tsx src/spikes/_diag_cficp_faq_compare.ts [sessionId]
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { resolveTableSearchTarget, exportTableRows } from '../services/dataverseTableExport.js';

const SESSION_ID = process.argv[2];
const DV_TABLE_SEARCH_NAME = 'CFICPProfile_FAQEntry_oFb1VjgcrvwKRpkyJrtUG';
const PROJECT = '231705905417';
const AGENT_PREFIX = 'bdf9b817-9b90-f111-b8da-0022480b1f83';

async function listAllDocs(saToken: string, storeId: string) {
  const docs: Array<{ id: string; structData: Record<string, unknown> }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${storeId}/branches/default_branch/documents`,
    );
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
    if (!res.ok) {
      console.log(`  documents.list failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      break;
    }
    const json = (await res.json()) as {
      documents?: Array<{ id: string; structData: Record<string, unknown> }>;
      nextPageToken?: string;
    };
    docs.push(...(json.documents ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return docs;
}

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');
  const env = (s.environments ?? []).find((e) => e.url.includes('org32322095')) ?? s.environments?.[0];
  if (!env) throw new Error('no environment on session');
  const msToken = await clientCredsToken(s.tenantId ?? '', env.url);
  const saToken = await getSaToken('zara@storefuze.com');

  const { targets } = await resolveTableSearchTarget(env.url, msToken, DV_TABLE_SEARCH_NAME);

  for (const t of targets) {
    console.log(`\n${'='.repeat(70)}\nTABLE: ${t.entitySetName}\n${'='.repeat(70)}`);
    const sourceRows = await exportTableRows(env.url, msToken, t.entitySetName, t.primaryKeyAttr, 5000);
    const storeId = `${AGENT_PREFIX}-tbl-${t.entitySetName.replace(/_/g, '-')}`;
    const destDocs = await listAllDocs(saToken, storeId);

    console.log(`SOURCE rows: ${sourceRows.length}   DESTINATION docs: ${destDocs.length}`);

    const sourceIds = new Set(sourceRows.map((r) => r.id));
    const destIds = new Set(destDocs.map((d) => d.id));
    const missingInDest = [...sourceIds].filter((id) => !destIds.has(id));
    const extraInDest = [...destIds].filter((id) => !sourceIds.has(id));
    console.log(`Missing in destination: ${missingInDest.length}   Extra in destination: ${extraInDest.length}`);

    // Field-level diff on the first 3 matched rows.
    const destById = new Map(destDocs.map((d) => [d.id, d.structData]));
    let checked = 0;
    for (const row of sourceRows) {
      if (checked >= 3) break;
      const dest = destById.get(row.id);
      if (!dest) continue;
      checked++;
      const sourceKeys = Object.keys(row.data).filter(
        (k) => !k.startsWith('@odata') && !k.startsWith('_') && !/FormattedValue$/.test(k),
      );
      const diffs: string[] = [];
      for (const k of sourceKeys) {
        if (JSON.stringify(row.data[k]) !== JSON.stringify(dest[k])) {
          diffs.push(`${k}: source=${JSON.stringify(row.data[k])} dest=${JSON.stringify(dest[k])}`);
        }
      }
      console.log(`\n  row ${row.id}: ${diffs.length === 0 ? 'MATCH (all fields identical)' : `${diffs.length} field diff(s)`}`);
      diffs.forEach((d) => console.log(`    ${d}`));
    }
  }

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});