import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getEntraSecret, upsertSecretIfChanged } from '../services/secretManager.js';
import { connectorSecretId, connectorFieldScope } from '../services/connectorCredentials.js';
import { getSaToken } from '../auth/google.js';
import type { Session } from '../sessionStore.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);
  const project = '505103737920';
  const appUserId = '6a5dfdff7cf05623332758b7';

  const oldSecretId = 'studio-enterprise-6a5dfdff7cf05623332758b7-shared-googledrive-service-account-json';
  const oldRes = await getEntraSecret(saToken, `projects/${project}/secrets/${oldSecretId}/versions/latest`, { optional: true });
  if (!oldRes.ok || !oldRes.plaintext) throw new Error('could not read existing Drive credential: ' + oldRes.error);
  console.log('Read existing Drive service_account_json (verified valid JSON earlier).');

  const newScope = connectorFieldScope('shared_googledrive', 'service_account_json');
  console.log('New shared group scope:', newScope);
  const newSecretId = connectorSecretId('shared_googledrive', 'service_account_json', appUserId);
  console.log('New group-scoped secret id:', newSecretId);

  const { written } = await upsertSecretIfChanged(saToken, project, newSecretId, oldRes.plaintext, {
    connectorId: 'google_service_account',
    appUserId,
  });
  console.log('Written new group secret:', written);

  // Update the connectorCredentials record for Drive (and create ones for Gmail/Calendar) so
  // the UI's "connected" state and secretIds map are consistent going forward.
  const coll = getDb().collection('connectorCredentials');
  for (const connectorId of ['shared_googledrive', 'shared_gmail', 'shared_googlecalendar']) {
    await coll.updateOne(
      { appUserId, connectorId, project },
      {
        $set: {
          appUserId, connectorId, project,
          secretIds: { service_account_json: newSecretId },
          fields: ['service_account_json'],
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    console.log(`connectorCredentials upserted for ${connectorId}`);
  }
  console.log('\nDone. Drive, Gmail, and Calendar now share one secret and one credential record.');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
