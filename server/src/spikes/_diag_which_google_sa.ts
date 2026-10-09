/** Which service account identity does each stored Google credential actually hold?
 *  A "credential group" is one UI row but can point at different keys per app user, and a
 *  DWD grant is per CLIENT ID -- so the only way to know whether a grant applies is to read
 *  the identity, not the row. Prints client_email / client_id ONLY, never key material. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const token = await getSaToken();
const rows = await getDb().collection('connectorCredentials')
  .find({}, { projection: { _id: 0, connectorId: 1, project: 1, secretIds: 1, appUserId: 1 } }).toArray();

const seen = new Set<string>();
for (const r of rows as any[]) {
  const sid = r.secretIds?.service_account_json;
  if (!sid) continue;
  const key = `${r.project}/${sid}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const got = await getEntraSecret(token, `projects/${r.project}/secrets/${sid}/versions/latest`, { optional: true });
  if (!got.ok || !got.plaintext) { console.log(`${r.connectorId.padEnd(22)} ${sid}  -> UNREADABLE`); continue; }
  try {
    const k = JSON.parse(got.plaintext) as { client_email?: string; client_id?: string };
    console.log(`appUser=${r.appUserId}  ${r.connectorId.padEnd(22)}`);
    console.log(`    secret   ${r.project}/${sid}`);
    console.log(`    identity ${k.client_email}  client_id=${k.client_id}`);
  } catch { console.log(`${sid} -> not a service-account key`); }
}
process.exit(0);
