/**
 * Which Google accounts has a Drive agent been confirmed to act as?
 *
 * The Drive tools are only ever deployed alongside a confirmed per-agent identity
 * (orchestrator drops the connector otherwise), so a harness that runs as the bare service
 * account is testing a configuration that never ships — the SA owns no Drive, which is why
 * root came back empty and the media upload 403'd.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const rows = await db.collection('agentConnectorIdentity').find({}).toArray();
console.log(`${rows.length} identity record(s)`);
for (const r of rows as Array<Record<string, unknown>>) {
  console.log(
    `  ${String(r.connectorId ?? '').padEnd(22)} agent=${String(r.agentId ?? r.sourceId ?? '?').slice(0, 38).padEnd(38)}` +
      ` status=${String(r.status ?? '?').padEnd(10)} ${String(r.impersonateEmail ?? '')}`,
  );
}
// Also the migration-wide secrets that already hold an impersonation target, since the
// e2e spikes wrote some by hand.
const names = await db.collection('connectorCredentials').find({}).project({ connectorId: 1, secretIds: 1 }).toArray();
console.log('\ncredential records naming an impersonate_email field:');
for (const n of names as Array<{ connectorId?: string; secretIds?: Record<string, string> }>) {
  if (n.secretIds && 'impersonate_email' in n.secretIds) {
    console.log(`  ${n.connectorId} -> ${n.secretIds.impersonate_email}`);
  }
}
process.exit(0);
