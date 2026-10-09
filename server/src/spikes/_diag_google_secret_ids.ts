/** Which secret does EACH Google connector actually end up pointing at, and whose key is in
 *  it? Field scoping says they share one group secret; the run reported two different client
 *  ids across them, so one of those two statements is wrong. Prints identities only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const token = await getSaToken();
const APP = process.env.CSGE_APP_USER ?? '6a7168dfc40369e8807f5cc3';
const rows = await getDb().collection('connectorCredentials')
  .find({ appUserId: APP }, { projection: { _id: 0, connectorId: 1, project: 1, secretIds: 1 } }).toArray();
console.log(`connectorCredentials rows for appUser ${APP}: ${rows.length}`);
for (const r of rows as any[]) {
  console.log(`  ${r.connectorId.padEnd(24)} ${r.project}  ${JSON.stringify(r.secretIds)}`);
}
console.log('');
for (const proj of ['agentmigrations', 'studio-enterprise-migration']) {
  for (const sid of [
    `studio-enterprise-${APP}-google-service-account-service-account-json`,
    `studio-enterprise-${APP}-shared-googledrive-service-account-json`,
  ]) {
    const got = await getEntraSecret(token, `projects/${proj}/secrets/${sid}/versions/latest`, { optional: true });
    if (!got.ok || !got.plaintext) { console.log(`${proj}/${sid}  -> ABSENT`); continue; }
    const k = JSON.parse(got.plaintext) as { client_email?: string; client_id?: string };
    console.log(`${proj}/${sid}`);
    console.log(`    -> ${k.client_email}  client_id=${k.client_id}`);
  }
}
process.exit(0);
