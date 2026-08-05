/**
 * Real, end-to-end spike for the NEW BigQuery-mediated Dataverse-snapshot
 * path: calls the actual shipped `migrateDataverseSnapshot` router (not a
 * hand-rolled copy) against the real connected Dataverse env + GCP project,
 * forcing the BigQuery branch via BQ_SNAPSHOT_ROW_THRESHOLD=0 so even a
 * small sample table exercises runBigQuerySnapshot for real.
 *
 *   npx tsx src/spikes/_diag_bq_snapshot_real_test.ts
 */
process.env.BQ_SNAPSHOT_ROW_THRESHOLD = '0'; // force every dvSnapshot through the BigQuery branch

import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveDestination } from '../services/gemini.js';
import { migrateDataverseSnapshot } from '../services/knowledgeDataStoreExecutor.js';
import type { KnowledgeSourceIR } from '../types.js';

const GEMINI_PROJECT = '231705905417';
const CANDIDATE_TABLES = ['contacts', 'accounts'];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');
  const env = (s.environments ?? []).find((e) => e.name === 'CloudFuze Migration Test') ?? s.environments?.[0];
  if (!env) throw new Error('no Dataverse environment found on the session');
  console.log(`Dataverse env: ${env.url}`);

  const dvToken = await clientCredsToken(s.tenantId ?? '', env.url);
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = await resolveDestination(GEMINI_PROJECT, saToken);
  console.log(`Gemini destination: project=${dest.project} engine=${dest.engine}`);

  for (const table of CANDIDATE_TABLES) {
    console.log(`\n=== Trying table "${table}" ===`);
    const source: KnowledgeSourceIR = {
      id: `spiketest-${table}`,
      name: `${table} (spike test)`,
      kind: 'DataverseTableSearch',
      reference: table,
      references: [table],
    };
    const result = await migrateDataverseSnapshot(
      dest,
      saToken,
      dvToken,
      env.url,
      `spiketest-bqreal-${Date.now().toString(36)}`,
      source,
    );
    console.log('Result:', JSON.stringify(result, null, 2));
    if (result.attempted > 0) {
      console.log(`\n>>> Using "${table}" for verification (attempted=${result.attempted}) <<<`);
      await verify(dest.project, result.dataStoreId);
      return;
    }
    console.log(`(no rows / not usable for "${table}": ${result.error ?? 'unknown'})`);
  }
  console.log('\nNo candidate table produced rows — nothing to verify.');
}

async function verify(project: string, dataStoreId: string | undefined) {
  if (!dataStoreId) {
    console.log('No dataStoreId returned — cannot verify.');
    return;
  }
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${dataStoreId}/servingConfigs/default_search:search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '*', pageSize: 3 }),
  });
  const text = await res.text();
  console.log('\n--- Direct search verification ---');
  console.log('status:', res.status);
  console.log(text.slice(0, 2000));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message, e.stack);
    process.exit(1);
  });
