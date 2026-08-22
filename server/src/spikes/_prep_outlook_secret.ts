/**
 * Create the one Secret Manager entry the keep-Outlook path needs beyond the shared
 * ms_graph credential: WHICH mailbox a deployed agent reads.
 *
 * The Graph credentials (tenant/client/secret) are already stored once for every Microsoft
 * connector. App-only Graph reaches EVERY mailbox in the tenant, so the mailbox is not
 * inferable — it is a per-agent decision, which is exactly what the surface-choice screen
 * collects. This spike stands in for that screen so the pipeline can be proven end to end.
 *
 * Idempotent: re-running adds a new version rather than failing.
 *
 *   cd server && npx tsx src/spikes/_prep_outlook_secret.ts [mailbox]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const MAILBOX = process.argv[2] || 'alex@filefuze.co';
const SECRET = 'studio-enterprise-shared-outlook-impersonate-email';

const token = await getSaToken();

const create = await fetch(
  `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${SECRET}`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replication: { automatic: {} } }),
  },
);
console.log(create.ok ? `created ${SECRET}` : create.status === 409 ? `exists  ${SECRET}` : `FAILED ${create.status} ${(await create.text()).slice(0, 160)}`);

const add = await fetch(
  `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET}:addVersion`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(MAILBOX, 'utf8').toString('base64') } }),
  },
);
console.log(add.ok ? `mailbox stored: ${MAILBOX}` : `FAILED addVersion ${add.status} ${(await add.text()).slice(0, 160)}`);
process.exit(0);
