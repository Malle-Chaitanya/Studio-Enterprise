/**
 * The reveal route's LOOKUP, exercised in-process (the HTTP route is behind session auth,
 * so a spike cannot reach it). Same scope-matching the route does.
 *
 * Prints only lengths and masked prefixes — never a full credential.
 *
 *   cd server && npx tsx src/spikes/_diag_reveal_logic.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';
import { connectorCredentialScope } from '../services/connectorCredentials.js';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { appUserId?: string; geminiProject?: string } | null;
const appUserId = s?.appUserId ?? '';
const destProject = s?.geminiProject ?? '';
const saToken = await getSaToken();
const saved = await listConnectorCredentials(appUserId);

async function lookup(connectorId: string, field: string) {
  const scope = connectorCredentialScope(connectorId);
  const rec = saved.find(
    (r) =>
      r.project === destProject &&
      (r.connectorId === connectorId || connectorCredentialScope(r.connectorId) === scope) &&
      !!r.secretIds?.[field],
  );
  if (!rec) return 'not_configured';
  const got = await getEntraSecret(saToken, `projects/${destProject}/secrets/${rec.secretIds![field]}/versions/latest`);
  if (!got.ok || !got.plaintext) return `unreadable (${got.error})`;
  return `${got.plaintext.slice(0, 4)}...(${got.plaintext.length} chars)`;
}

for (const [c, f] of [
  ['shared_teams', 'tenant_id'], ['shared_teams', 'client_id'], ['shared_teams', 'client_secret'],
  ['shared_office365', 'client_secret'], ['shared_jira', 'api_token'], ['shared_confluence', 'base_url'],
  ['shared_googledrive', 'service_account_json'],
] as const) {
  console.log(`  ${c}.${f}`.padEnd(46) + (await lookup(c, f)));
}
console.log('\n  must NOT resolve:');
for (const [c, f] of [['shared_doesnotexist', 'api_key'], ['shared_teams', 'not_a_field'], ['shared_teams', '']] as const) {
  console.log(`  ${c}.${f || '(empty)'}`.padEnd(46) + (await lookup(c, f)));
}
process.exit(0);
