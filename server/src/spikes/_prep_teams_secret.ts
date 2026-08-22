/**
 * The Teams user a deployed agent reads as.
 *
 * Kept SEPARATE from the Outlook mailbox secret. Reusing that one pointed the Teams agent at
 * a user with no teams and no chats, so every tool returned 200 with an empty list and the
 * agent said "I don't see any chat spaces" — a hollow pass that looks like a working agent
 * reporting an empty tenant. The mail identity and the Teams identity are different facts.
 *
 *   cd server && npx tsx src/spikes/_prep_teams_secret.ts [user@domain]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const USER = process.argv[2] || 'Alex@qatestagent.com';
const SECRET = 'studio-enterprise-shared-teams-impersonate-email';
const token = await getSaToken();

const create = await fetch(
  `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${SECRET}`,
  { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replication: { automatic: {} } }) },
);
console.log(create.ok ? `created ${SECRET}` : create.status === 409 ? `exists  ${SECRET}` : `FAILED ${create.status}`);
const add = await fetch(
  `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET}:addVersion`,
  { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(USER, 'utf8').toString('base64') } }) },
);
console.log(add.ok ? `teams user stored: ${USER}` : `FAILED addVersion ${add.status}`);
process.exit(0);
