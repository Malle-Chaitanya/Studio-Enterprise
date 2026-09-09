import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getEntraSecret } from '../services/secretManager.js';
import { getSaToken } from '../auth/google.js';
import type { Session } from '../sessionStore.js';
import { JWT } from 'google-auth-library';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);
  const project = '505103737920';
  const sourceId = 'ca01dff9-279d-f111-b8de-0022480b19e9';

  const jsonSecretId = 'studio-enterprise-6a5dfdff7cf05623332758b7-shared-googledrive-service-account-json';
  const emailSecretId = `studio-enterprise-6a5dfdff7cf05623332758b7-shared-googledrive-agent-${sourceId}-impersonate-email`;
  console.log('Testing the REAL per-agent secret:', emailSecretId);

  const jsonRes = await getEntraSecret(saToken, `projects/${project}/secrets/${jsonSecretId}/versions/latest`, { optional: true });
  const emailRes = await getEntraSecret(saToken, `projects/${project}/secrets/${emailSecretId}/versions/latest`, { optional: true });
  console.log('service_account_json readable:', jsonRes.ok);
  console.log('per-agent impersonate_email readable:', emailRes.ok, '| value:', emailRes.plaintext, '| error:', emailRes.error);

  if (jsonRes.ok && jsonRes.plaintext && emailRes.ok && emailRes.plaintext) {
    console.log('\n--- Attempting real DWD token mint + Drive API call ---');
    const info = JSON.parse(jsonRes.plaintext);
    const auth = new JWT({
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
      console.log((await driveRes.text()).slice(0, 800));
    } catch (e) {
      console.log('Token mint / API call FAILED:', (e as Error).message);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
