/** Prints the RAW Discovery Engine import operation response (not run through our own
 *  reconcileImport parsing) to see Google's actual error shape for the failing
 *  cr88d_faqentries rows, since our own failureSamples extraction is showing "unknown
 *  error" — meaning either the real field names differ from what importReconcile.ts
 *  expects, or Google genuinely returns no per-row detail for this failure type.
 *   npx tsx src/spikes/_diag_raw_import_operation.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, effectiveGeminiProject } from '../services/gemini.js';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const env = (s.environments ?? []).find((e) => e.name === 'CloudFuze Agent Migration Hub');
  if (!env) throw new Error('env not found');
  const dvToken = await clientCredsToken(s.tenantId ?? '', env.url);

  const saToken = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const dest = await resolveDestination('studio-enterprise-migration', saToken);
  const project = effectiveGeminiProject(dest.project);

  // Grab 3 real rows from the table to import directly.
  const rows = await dvGet(env.url, dvToken, `cr88d_faqentries?$top=3`);
  console.log('Sample raw rows (first one, all fields):', JSON.stringify(rows.value[0], null, 2).slice(0, 1500));

  const dataStoreId = 'diag-raw-import-test';
  const createRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores?dataStoreId=${dataStoreId}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'diag raw import test', industryVertical: 'GENERIC', solutionTypes: ['SOLUTION_TYPE_SEARCH'], contentConfig: 'NO_CONTENT' }),
    },
  );
  console.log('\nCreate data store:', createRes.status, (await createRes.text()).slice(0, 200));

  const docs = rows.value.map((r, i) => ({ id: String(r.cr88d_faqentryid ?? i), structData: r }));
  const importRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${dataStoreId}/branches/default_branch/documents:import`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inlineSource: { documents: docs }, reconciliationMode: 'INCREMENTAL' }),
    },
  );
  const importBody = await importRes.json() as { name?: string };
  console.log('\nImport started:', importRes.status, JSON.stringify(importBody));

  if (importBody.name) {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const opRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${importBody.name}`, { headers: { Authorization: `Bearer ${saToken}` } });
      const opBody = await opRes.json();
      console.log(`\nPoll ${i}: done=${(opBody as any).done}`);
      if ((opBody as any).done) {
        console.log('FULL RAW OPERATION:', JSON.stringify(opBody, null, 2));
        break;
      }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
