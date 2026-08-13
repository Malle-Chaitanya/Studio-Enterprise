/** Live Google Drive check using the EXACT production auth path (adk_deploy.py's
 *  _mint_token for auth_kind "google-service-account"): the customer's OWN stored
 *  service_account_json + impersonate_email secrets, DWD, scope
 *  https://www.googleapis.com/auth/drive (registry.ts requiredPermissions) — not
 *  CloudFuze's own SA. Read-only files.list. Never logs the key material.
 *  npx tsx src/spikes/_diag_check_drive_live.ts */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import { getEntraSecret } from '../services/secretManager.js';

interface CredRow {
  appUserId: string;
  connectorId: string;
  secretIds: Record<string, string>;
  project: string;
}

async function main() {
  await connectMongo();
  const row = await getDb()
    .collection<CredRow>('connectorCredentials')
    .findOne({ connectorId: 'shared_googledrive' });
  if (!row) throw new Error('no shared_googledrive credential stored');

  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const ourKey = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: ourKey.client_email, key: ourKey.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();

  const candidateProjects = [row.project, '231705905417', '72860638029'].filter((p, i, a) => a.indexOf(p) === i);
  let saJsonRes, impersonateRes, usedProject = '';
  for (const project of candidateProjects) {
    saJsonRes = await getEntraSecret(access_token!, `projects/${project}/secrets/${row.secretIds.service_account_json}/versions/latest`);
    if (saJsonRes.ok) { usedProject = project; break; }
    console.log(`  (no read access to project ${project}: ${saJsonRes.error?.slice(0, 80)})`);
  }
  if (!saJsonRes?.ok || !saJsonRes.plaintext) throw new Error(`could not read service_account_json from any candidate project`);
  impersonateRes = await getEntraSecret(access_token!, `projects/${usedProject}/secrets/${row.secretIds.impersonate_email}/versions/latest`);
  console.log(`  found secret in project ${usedProject}`);
  if (!impersonateRes.ok || !impersonateRes.plaintext) throw new Error(`could not read impersonate_email: ${impersonateRes.error}`);
  const impersonate = impersonateRes.plaintext.trim();

  const custKey = JSON.parse(saJsonRes.plaintext) as { client_email: string; private_key: string };
  console.log(`customer SA client_email=${custKey.client_email}  impersonating=${impersonate}\n`);

  const driveToken = await new JWT({
    email: custKey.client_email,
    key: custKey.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
    subject: impersonate,
  }).authorize();

  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files?pageSize=5&fields=files(id,name,mimeType)',
    { headers: { Authorization: `Bearer ${driveToken.access_token}` } },
  );
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 1500));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
