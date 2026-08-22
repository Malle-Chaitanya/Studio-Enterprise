/**
 * Store the Google Chat credential under the TENANT-SCOPED secret name the pipeline derives.
 *
 * `_prep_chat_secrets.ts` writes `studio-enterprise-shared-googlechat-*` — the legacy,
 * un-scoped namespace every customer would share. The orchestrator resolves
 * `connectorSecretId(id, field, credentialScope(session))`, which for this tenant is
 * `studio-enterprise-6a7168dfc40369e8807f5cc3-shared-googlechat-*`. A deployed agent
 * therefore looked for a secret nothing had written, and every Chat tool failed at inference
 * with "Secret ... not found or has no versions" — caught by the pre-flight gate before
 * deploy, and confirmed live afterwards.
 *
 * Derives the id through `connectorSecretId` rather than typing it, so it cannot drift from
 * whatever the orchestrator will ask for.
 *
 *   cd server && npx tsx src/spikes/_prep_chat_tenant_scoped.ts [subject-email]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { upsertSecretIfChanged } from '../services/secretManager.js';
import { upsertConnectorCredential } from '../db/repos/connectorCredentials.js';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const CONNECTOR = 'shared_googlechat';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { appUserId?: string; geminiProject?: string; tenantId?: string } | null;
const appUserId = s?.appUserId ?? '';
const project = s?.geminiProject ?? '';
// Same scope the routes use: see credentialScope() in routes/migrate.ts — the appUserId is
// the owner scope for a per-customer credential.
const ownerScope = appUserId;
console.log(`appUserId : ${appUserId}`);
console.log(`project   : ${project}`);
console.log(`subject   : ${SUBJECT}\n`);

const keyFile = process.env.GOOGLE_SA_KEY_FILE || './service_account.json';
const saJson = process.env.GOOGLE_SA_KEY_JSON || readFileSync(keyFile, 'utf8');
const parsed = JSON.parse(saJson) as { client_email?: string };
console.log(`service account: ${parsed.client_email}\n`);

const saToken = await getSaToken();
const fields: Record<string, string> = {
  service_account_json: saJson,
  impersonate_email: SUBJECT,
  // Write tools stay gated: Chat message creation needs a Chat app configured on the Cloud
  // project, which this tenant does not have. Handing the model write tools that cannot work
  // is worse than not having them.
  chat_app_configured: 'false',
};

const secretIds: Record<string, string> = {};
for (const [field, value] of Object.entries(fields)) {
  const secretId = connectorSecretId(CONNECTOR, field, ownerScope);
  const res = await upsertSecretIfChanged(saToken, project, secretId, value, {
    managed_by: 'studio-enterprise',
    app_user: appUserId,
    connector: CONNECTOR,
  });
  secretIds[field] = secretId;
  console.log(`  ${res.ok ? 'ok  ' : 'FAIL'} ${secretId}`);
  if (!res.ok) console.log(`       ${res.error}`);
}

await upsertConnectorCredential(appUserId, {
  connectorId: CONNECTOR,
  project,
  fields: Object.keys(secretIds),
  secretIds,
});
console.log(`\nrecorded ${CONNECTOR} with ${Object.keys(secretIds).length} field(s) for ${appUserId}`);
process.exit(0);
