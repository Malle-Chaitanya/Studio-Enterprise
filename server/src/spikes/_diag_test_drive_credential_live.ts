import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getEntraSecret } from '../services/secretManager.js';
import { getSaToken } from '../auth/google.js';
import type { Session } from '../sessionStore.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);
  const project = '505103737920';

  const cc = await getDb().collection('connectorCredentials').findOne({ connectorId: 'shared_googledrive' });
  if (!cc) throw new Error('no Drive credential record');
  const jsonSecretId = cc.secretIds.service_account_json;
  const emailSecretId = cc.secretIds.impersonate_email;
  console.log('service_account_json secretId:', jsonSecretId);
  console.log('impersonate_email secretId:', emailSecretId);

  const jsonRes = await getEntraSecret(saToken, `projects/${project}/secrets/${jsonSecretId}/versions/latest`, { optional: true });
  console.log('\nservice_account_json readable:', jsonRes.ok);
  if (jsonRes.ok && jsonRes.plaintext) {
    try {
      const parsed = JSON.parse(jsonRes.plaintext);
      console.log('  valid JSON, client_email:', parsed.client_email, '| project_id:', parsed.project_id, '| type:', parsed.type);
    } catch (e) {
      console.log('  NOT valid JSON:', (e as Error).message, '| first 100 chars:', jsonRes.plaintext.slice(0, 100));
    }
  } else {
    console.log('  error:', jsonRes.error);
  }

  const emailRes = await getEntraSecret(saToken, `projects/${project}/secrets/${emailSecretId}/versions/latest`, { optional: true });
  console.log('\nimpersonate_email readable:', emailRes.ok, '| value:', emailRes.plaintext);

  // Now actually try to mint a DWD token and call Drive, exactly like the deployed container would.
  if (jsonRes.ok && jsonRes.plaintext && emailRes.ok && emailRes.plaintext) {
    console.log('\n--- Attempting real DWD token mint + Drive API call ---');
    const { GoogleAuth } = await import('google-auth-library');
    const info = JSON.parse(jsonRes.plaintext);
    const auth = new (await import('google-auth-library')).JWT({
      email: info.client_email,
      key: info.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
      subject: emailRes.plaintext,
    });
    try {
      const token = await auth.getAccessToken();
      console.log('Token minted OK, length:', token.token?.length);
      const driveRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=5', {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      console.log('Drive API call status:', driveRes.status);
      console.log(await driveRes.text());
    } catch (e) {
      console.log('Token mint / API call FAILED:', (e as Error).message);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
