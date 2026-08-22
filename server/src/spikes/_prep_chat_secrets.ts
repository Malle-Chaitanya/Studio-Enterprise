/**
 * Create the Secret Manager entries a deployed Google Chat connector needs.
 *
 * Same security debt as _prep_gmail_secrets.ts, recorded rather than hidden: this stores the
 * PLATFORM service account's key in a connector secret readable by a Reasoning Engine
 * container. The right shape is a dedicated `chat-connector-sa` with no project roles whose
 * client id is granted only the Chat scopes in the Workspace DWD console. Taken knowingly to
 * reach a live proof faster; swapping it is: create the SA, grant its client id, re-run this.
 *
 * `chat_app_configured` gates the WRITE tools. It is stored as a credential rather than a
 * code constant because it is a per-customer fact — Chat message creation needs a Chat app
 * configured on the Cloud project, and until then the write tools must not be handed to the
 * model at all.
 *
 *   cd server && npx tsx src/spikes/_prep_chat_secrets.ts [subject-email] [writes:true|false]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const WRITES = (process.argv[3] || 'false').toLowerCase();

const token = await getSaToken();

async function ensureSecret(id: string, value: string): Promise<void> {
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
  else { console.log(`  FAILED   ${id} -> ${create.status} ${(await create.text()).slice(0, 160)}`); return; }

  const add = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${id}:addVersion`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
    },
  );
  console.log(add.ok ? `  version  added` : `  FAILED addVersion ${add.status}`);
}

const keyFile = process.env.GOOGLE_SA_KEY_FILE || './service_account.json';
const keyJson = process.env.GOOGLE_SA_KEY_JSON || readFileSync(keyFile, 'utf8');
const parsed = JSON.parse(keyJson) as { client_email?: string; client_id?: string };

// Identity only — the key itself is never printed.
console.log(`storing identity : ${parsed.client_email}`);
console.log(`client id        : ${parsed.client_id}`);
console.log(`impersonating    : ${SUBJECT}`);
console.log(`writes enabled   : ${WRITES}\n`);

await ensureSecret('studio-enterprise-shared-googlechat-service-account-json', keyJson);
await ensureSecret('studio-enterprise-shared-googlechat-impersonate-email', SUBJECT);
await ensureSecret('studio-enterprise-shared-googlechat-chat-app-configured', WRITES);
process.exit(0);
