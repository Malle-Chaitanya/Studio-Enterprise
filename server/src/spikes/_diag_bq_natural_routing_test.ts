/**
 * Real, UNFORCED test of the BigQuery auto-routing itself — no threshold
 * override. Uses `systemusers` (confirmed 250+ rows in the connected test
 * tenant) so the router's own probe (exportTableRows(..., threshold+1)) has
 * to naturally detect the table exceeds config.BQ_SNAPSHOT_ROW_THRESHOLD
 * (default 200) and switch to runBigQuerySnapshot on its own — the exact
 * scenario the feature exists for, which the earlier spike bypassed by
 * forcing the threshold to 0.
 *
 *   npx tsx src/spikes/_diag_bq_natural_routing_test.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveDestination } from '../services/gemini.js';
import { migrateDataverseSnapshot } from '../services/knowledgeDataStoreExecutor.js';
import type { KnowledgeSourceIR } from '../types.js';
import { config } from '../config.js';

const GEMINI_PROJECT = '231705905417';
const TABLE = 'systemusers';

async function main() {
  console.log(`Using REAL default threshold: ${config.BQ_SNAPSHOT_ROW_THRESHOLD} (not forced/overridden)`);

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

  const source: KnowledgeSourceIR = {
    id: `spiketest-natural-${TABLE}`,
    name: `${TABLE} (natural routing test)`,
    kind: 'DataverseTableSearch',
    reference: TABLE,
    references: [TABLE],
  };
  const started = Date.now();
  const result = await migrateDataverseSnapshot(
    dest,
    saToken,
    dvToken,
    env.url,
    `spiketest-natural-${Date.now().toString(36)}`,
    source,
  );
  const elapsedMs = Date.now() - started;

  console.log(`\nElapsed: ${elapsedMs}ms`);
  console.log('Result (schemaNotes omitted for brevity):', JSON.stringify({ ...result, schemaNotes: result.schemaNotes ? `${result.schemaNotes.length} notes` : undefined }, null, 2));

  if (result.viaBigQuery) {
    console.log('\n✅ Natural routing correctly selected the BigQuery path WITHOUT any threshold override.');
  } else {
    console.log('\n❌ Did NOT take the BigQuery path — router picked inline despite exceeding the default threshold. BUG.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message, e.stack);
    process.exit(1);
  });
