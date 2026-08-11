/**
 * Live check: does the BigQuery-mediated Dataverse-snapshot path work end to
 * end against the CURRENT session's real connected destination (not a
 * hardcoded old project id)? Forces every table through runBigQuerySnapshot
 * via BQ_SNAPSHOT_ROW_THRESHOLD=0, then re-checks search after a short delay
 * to rule out indexing lag before concluding "not searchable."
 *   npx tsx src/spikes/_diag_verify_dv_snapshot_bigquery.ts
 */
// BQ_SNAPSHOT_ROW_THRESHOLD=0 MUST be set as a real shell env var when invoking
// this script (e.g. `BQ_SNAPSHOT_ROW_THRESHOLD=0 npx tsx ...`) — an in-file
// process.env assignment here silently no-ops because ES module import
// hoisting runs config.ts's parse before any in-file code executes (see
// .claude/memory/decisions.md, 2026-08-04).

import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveDestination } from '../services/gemini.js';
import { migrateDataverseSnapshot } from '../services/knowledgeDataStoreExecutor.js';
import type { KnowledgeSourceIR } from '../types.js';

const CANDIDATE_TABLES = ['contacts', 'accounts'];

async function search(project: string, saToken: string, dataStoreId: string) {
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${dataStoreId}/servingConfigs/default_search:search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '*', pageSize: 3 }),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, resultCount: Array.isArray(json.results) ? json.results.length : 0, raw: json };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');
  const env = (s.environments ?? []).find((e) => e.name === 'CloudFuze Migration Test') ?? s.environments?.[0];
  if (!env) throw new Error('no Dataverse environment found on the session');
  console.log(`Dataverse env: ${env.url}`);

  const dvToken = await clientCredsToken(s.tenantId ?? '', env.url);
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = await resolveDestination(s.geminiProject ?? '', saToken);
  console.log(`Gemini destination (current session): project=${dest.project} engine=${dest.engine}`);

  for (const table of CANDIDATE_TABLES) {
    console.log(`\n=== Trying table "${table}" (forced BigQuery path) ===`);
    const source: KnowledgeSourceIR = {
      id: `spiketest-${table}`,
      name: `${table} (bq spike test)`,
      kind: 'DataverseTableSearch',
      reference: table,
      references: [table],
    };
    const result = await migrateDataverseSnapshot(
      dest,
      saToken,
      dvToken,
      env.url,
      `spiketest-bq2-${Date.now().toString(36)}`,
      source,
    );
    console.log('Result:', JSON.stringify({ ...result, resourcePath: result.resourcePath }, null, 2));
    if (result.attempted === 0 || !result.dataStoreId) {
      console.log(`(no rows / not usable for "${table}": ${result.error ?? 'unknown'})`);
      continue;
    }
    console.log(`viaBigQuery=${!!result.viaBigQuery}`);

    for (const attempt of [0, 15000, 30000]) {
      if (attempt > 0) {
        console.log(`(waiting ${attempt / 1000}s for indexing...)`);
        await new Promise((r) => setTimeout(r, attempt));
      }
      const found = await search(dest.project, saToken, result.dataStoreId);
      console.log(`search status=${found.status} resultCount=${found.resultCount}`);
      if (found.resultCount > 0) {
        console.log('CONFIRMED: BigQuery-backed snapshot is actually searchable/retrievable.');
        console.log(JSON.stringify(found.raw.results?.[0], null, 2).slice(0, 1500));
        return;
      }
    }
    console.log(`"${table}" imported but returned zero search results after retries — treat as unresolved, not confirmed.`);
    return;
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message, e.stack);
    process.exit(1);
  });
