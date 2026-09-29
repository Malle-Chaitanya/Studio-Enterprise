/**
 * Verifies the Zendesk auth-fix live against the DB: confirms authParameters keeps
 * BOTH connection-parameter entries (token:SubDomain plain field, token real OAuth
 * entry) and that primaryAuth correctly picked the oauthSetting one with its real
 * scope, instead of the plain subdomain field that was wrongly picked before.
 *
 * Run: npx tsx src/spikes/_diag_verify_zendesk_auth_fix.ts
 */
import { connectDb, closeDb, getDb } from '../db/core.js';
import { config } from '../config.js';
import type { ConnectorRecord } from '../db/repos/connectorRegistry.js';

async function main() {
  await connectDb(config.CSGE_DB);
  const rec = await getDb(config.CSGE_DB).collection<ConnectorRecord>('connectors').findOne({ connectorId: 'shared_zendesk' });
  console.log(JSON.stringify(rec, null, 2));
  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
