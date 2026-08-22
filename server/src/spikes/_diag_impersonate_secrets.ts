/**
 * Which impersonate_email secrets exist, for which connector?
 *
 * The Teams tools correctly refuse to guess a user ("No user is configured for this agent"),
 * so proving them needs the same secret the deployed agent gets. Only Drive has an
 * agentConnectorIdentity record, yet a Teams migration was proven end to end earlier — so a
 * Teams user secret exists under some other name. Listed rather than guessed.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSaToken } from '../auth/google.js';

await connectMongo();
const token = await getSaToken();
const project = 'studio-enterprise-migration';
const res = await fetch(
  `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?pageSize=300&filter=name:impersonate`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const body = (await res.json()) as { secrets?: Array<{ name: string }> };
const names = (body.secrets ?? []).map((s) => s.name.split('/').pop()!).sort();
console.log(`${names.length} secret(s) matching "impersonate":`);
for (const n of names) console.log(`  ${n}`);
process.exit(0);
