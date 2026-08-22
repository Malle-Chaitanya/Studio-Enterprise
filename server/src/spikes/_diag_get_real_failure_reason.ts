/** Calls the REAL production migrateDataverseSnapshot() directly against
 *  cr88d_faqentries (the table that showed "0/20 row(s) indexed, 20 failed" in the live
 *  migration log) to capture the actual failureSamples text, instead of guessing.
 *   npx tsx src/spikes/_diag_get_real_failure_reason.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { migrateDataverseSnapshot } from '../services/knowledgeDataStoreExecutor.js';
import type { KnowledgeSourceIR } from '../types.js';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  return res.json();
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const env = (s.environments ?? []).find((e) => e.name === 'CloudFuze Agent Migration Hub');
  if (!env) throw new Error('env not found');
  const dvToken = await clientCredsToken(s.tenantId ?? '', env.url);

  // Find the primary key attribute for cr88d_faqentries.
  const meta = await dvGet(env.url, dvToken, `EntityDefinitions(LogicalName='cr88d_faqentry')?$select=PrimaryIdAttribute`) as { PrimaryIdAttribute?: string };
  console.log('PrimaryIdAttribute:', meta.PrimaryIdAttribute);
  const pk = meta.PrimaryIdAttribute ?? 'cr88d_faqentryid';

  const saToken = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const dest = await resolveDestination('studio-enterprise-migration', saToken);

  const fakeSource = { references: ['cr88d_faqentries'] } as unknown as KnowledgeSourceIR;

  const result = await migrateDataverseSnapshot(
    dest, saToken, dvToken, env.url, 'diag-real-failure-check', fakeSource,
    { entitySetName: 'cr88d_faqentries', primaryKeyAttr: pk },
  );
  console.log('\nResult:', JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
