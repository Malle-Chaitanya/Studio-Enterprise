/**
 * Create the Secret Manager entries a deployed Gmail connector needs.
 *
 * SECURITY DEBT, recorded deliberately (decision 2026-08-19): this stores the PLATFORM
 * service account's key (studio-enterprise-migration@..., the identity that deploys
 * Reasoning Engines and holds cloud-platform scope) in a connector secret readable by a
 * Reasoning Engine container. That is more privilege than a mail-reading tool needs.
 *
 * The right shape is a dedicated `gmail-connector-sa` with no project roles, whose client id
 * is granted only gmail.readonly in the Workspace DWD console — mirroring the existing
 * drive-connector-sa pattern. This was taken knowingly to reach a live proof faster.
 * Swapping it means: create the SA, grant its client id in Workspace, re-run this with the
 * new key. Nothing else changes.
 *
 * Idempotent: re-running adds a new version rather than failing.
 *
 *   cd server && npx tsx src/spikes/_prep_gmail_secrets.ts [subject-email]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const KEY_SECRET = 'studio-enterprise-shared-gmail-service-account-json';
const SUBJECT_SECRET = 'studio-enterprise-shared-gmail-impersonate-email';

const token = await getSaToken();

async function ensureSecret(id: string, value: string): Promise<void> {
  // Create. 409 = already there, which is the normal path on a re-run.
  const create = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${id}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    },
  );
  if (create.ok) console.log(`  created  ${id}`);
  else if (create.status === 409) console.log(`  exists   ${id}`);
  else {
    const t = await create.text();
    console.log(`  FAILED   ${id} -> ${create.status} ${t.slice(0, 160)}`);
    return;
  }

  const add = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}:addVersion`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
    },
  );
  if (add.ok) {
    const j = (await add.json()) as { name?: string };
    console.log(`  version  ${j.name?.split('/').slice(-3).join('/') ?? 'added'}`);
  } else {
    console.log(`  FAILED addVersion ${id} -> ${add.status} ${(await add.text()).slice(0, 160)}`);
  }
}

const keyFile = process.env.GOOGLE_SA_KEY_FILE || './service_account.json';
const keyJson = readFileSync(keyFile, 'utf8');
const parsed = JSON.parse(keyJson) as { client_email?: string; client_id?: string };

// Identity only. The key itself is never printed.
console.log(`storing identity : ${parsed.client_email}`);
console.log(`client id        : ${parsed.client_id}`);
console.log(`impersonating    : ${SUBJECT}\n`);

await ensureSecret(KEY_SECRET, keyJson);
await ensureSecret(SUBJECT_SECRET, SUBJECT);

console.log('\nsecretIds for the connector spec:');
console.log(`  service_account_json : ${KEY_SECRET}`);
console.log(`  impersonate_email    : ${SUBJECT_SECRET}`);
process.exit(0);
