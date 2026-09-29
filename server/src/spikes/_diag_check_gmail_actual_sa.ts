/** What service account does the Gmail connector ACTUALLY use at runtime (not our tool's
 *  own SA), and does IT have the gmail.modify DWD grant for admin@migrationn.com?
 *  Never prints the raw key. npx tsx src/spikes/_diag_check_gmail_actual_sa.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getConnectorCredential } from '../db/repos/connectorCredentials.js';
import { getEntraSecret } from '../services/secretManager.js';
import { getSaToken } from '../auth/google.js';
import { JWT } from 'google-auth-library';

await connectMongo();
const appUserId = '6a5dfdff7cf05623332758b7';

const rec = await getConnectorCredential(appUserId, 'shared_gmail');
console.log('shared_gmail credential record:', JSON.stringify(rec, null, 2));

if (!rec?.secretIds?.service_account_json) {
  console.log('No service_account_json secret configured for shared_gmail — cannot test.');
  process.exit(0);
}

const adminSaToken = await getSaToken();
const secretRes = await getEntraSecret(adminSaToken, `projects/${rec.project}/secrets/${rec.secretIds.service_account_json}/versions/latest`);
if (!secretRes.ok || !secretRes.plaintext) {
  console.log('Could not read the stored service_account_json secret:', secretRes.error);
  process.exit(0);
}
const info = JSON.parse(secretRes.plaintext) as { client_email?: string; private_key?: string };
console.log('\nThe ACTUAL Gmail-connector service account client_email:', info.client_email);

const IMPERSONATE = 'admin@migrationn.com';
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const client = new JWT({ email: info.client_email, key: info.private_key, scopes: [SCOPE], subject: IMPERSONATE });

console.log(`\nMinting a DWD token AS THIS SPECIFIC SA: scope=${SCOPE} subject=${IMPERSONATE}`);
let token: string | undefined;
try {
  const res = await client.authorize();
  token = res.access_token ?? undefined;
  console.log(`Token mint: OK (length ${token?.length ?? 0})`);
} catch (e) {
  console.log('Token mint FAILED for THIS SA — this is very likely the real root cause:');
  console.log(String((e as Error).message).slice(0, 1000));
  process.exit(0);
}

console.log('\nAttempting a real Gmail draft create (write-scope test, safe/reversible)...');
const mime = Buffer.from(`To: ${IMPERSONATE}\r\nSubject: CSGE scope-diagnostic (safe to delete)\r\n\r\nDraft-only diagnostic.`).toString('base64url');
const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { raw: mime } }),
});
console.log('Create draft status:', createRes.status);
const text = await createRes.text();
console.log(text.slice(0, 1500));
if (createRes.ok) {
  const json = JSON.parse(text) as { id?: string };
  if (json.id) {
    const delRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${json.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    console.log(`Cleaned up: ${delRes.status === 204 ? 'deleted OK' : delRes.status}`);
  }
}
process.exit(0);
