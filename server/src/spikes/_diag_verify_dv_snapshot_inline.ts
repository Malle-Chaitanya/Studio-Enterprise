/**
 * Live check: does the DEFAULT (inline, small-table) Dataverse-snapshot path
 * still work end to end against the real connected test tenant? Uses the
 * real shipped `migrateDataverseSnapshot` router with NO threshold override —
 * whichever candidate table is small enough naturally takes runInlineSnapshot.
 *   npx tsx src/spikes/_diag_verify_dv_snapshot_inline.ts
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
  const dest = await resolveDestination(s.geminiProject ?? '', saToken);
  console.log(`Gemini destination: project=${dest.project} engine=${dest.engine}`);

  for (const table of CANDIDATE_TABLES) {
    console.log(`\n=== Trying table "${table}" (default threshold, no override) ===`);
    const source: KnowledgeSourceIR = {
      id: `spiketest-${table}`,
      name: `${table} (inline spike test)`,
      kind: 'DataverseTableSearch',
      reference: table,
      references: [table],
    };
    const result = await migrateDataverseSnapshot(
      dest,
      saToken,
      dvToken,
      env.url,
      `spiketest-inline-${Date.now().toString(36)}`,
      source,
    );
    console.log('Result:', JSON.stringify(result, null, 2));
    if (result.attempted > 0) {
      console.log(`\n>>> "${table}" attempted=${result.attempted} viaBigQuery=${!!result.viaBigQuery} <<<`);
      if (!result.viaBigQuery) {
        console.log('CONFIRMED: this table naturally took the INLINE path.');
        return;
      }
      console.log('(this table was actually large enough to route to BigQuery on its own — trying next candidate for a true inline case)');
    } else {
      console.log(`(no rows / not usable for "${table}": ${result.error ?? 'unknown'})`);
    }
  }
  console.log('\nNo candidate table exercised the inline path — all were empty or routed to BigQuery.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message, e.stack);
    process.exit(1);
  });
