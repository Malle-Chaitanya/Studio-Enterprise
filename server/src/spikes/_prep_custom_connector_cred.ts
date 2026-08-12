/**
 * Point the custom HubSpot connector at the HubSpot token this tenant already stores.
 *
 * TEST SETUP, not product behaviour. In production the customer pastes the token on the
 * connector screen (which now offers a field for a custom connector). Here the same
 * token already exists in Secret Manager for `shared_hubspotcrmv2`, and the durable
 * record stores a per-field SECRET ID — so the custom connector can be pointed at it
 * without this script ever seeing, printing or copying a credential value.
 *
 * Reusing it is a deliberate choice for the proof run and NOT something the product
 * should ever do on its own: a token that happens to reach the same vendor is still a
 * different credential, and silently sharing one across connectors would be a decision
 * the customer never made.
 *
 * Verifies the secret is readable BEFORE writing the record, so a live migration is not
 * spent discovering the credential was never there.
 *
 * npx tsx src/spikes/_prep_custom_connector_cred.ts [--commit]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import { preflightSecretAccess } from '../services/secretManager.js';
import { getSaToken, serviceAccountEmail } from '../auth/google.js';

const COMMIT = process.argv.includes('--commit');
const CUSTOM_ID = 'shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b';

await connectMongo();
const coll = getDb(config.CSGE_DB).collection('connectorCredentials');

const source = (await coll.findOne({ connectorId: 'shared_hubspotcrmv2' })) as
  | { appUserId?: string; fields?: string[]; secretIds?: Record<string, string>; project?: string }
  | null;
if (!source) {
  console.error('no stored credential for shared_hubspotcrmv2 — nothing to point at');
  process.exit(1);
}
const secretId = source.secretIds?.api_key;
if (!secretId || !source.project) {
  console.error('source record has no api_key secret id or project');
  process.exit(1);
}
console.log(`source record: connector=shared_hubspotcrmv2 project=${source.project}`);
console.log(`               secret id=${secretId}   (id only — no value is read here)`);

// Can the service account actually READ it? A record pointing at an unreadable secret
// produces a tool that 401s, which looks like a binding bug and is not one.
// preflightSecretAccess(project, saToken, saEmail) — the second argument is the TOKEN.
// Passing the secret-id array here sent an array as the bearer and produced a 401 that
// looked exactly like a broken credential. The 401 was mine.
const saToken = await getSaToken();
const pre = await preflightSecretAccess(source.project, saToken, serviceAccountEmail()).catch((e) => ({
  ok: false,
  detail: (e as Error).message,
}));
console.log(`preflight: ${JSON.stringify(pre)}`);

const existing = await coll.findOne({ connectorId: CUSTOM_ID });
console.log(`\ncustom connector record currently: ${existing ? 'PRESENT' : 'absent'}`);

if (!COMMIT) {
  console.log('\nDRY RUN — pass --commit to write the record.');
  process.exit(0);
}
await coll.updateOne(
  { appUserId: source.appUserId, connectorId: CUSTOM_ID },
  {
    $set: {
      appUserId: source.appUserId,
      connectorId: CUSTOM_ID,
      fields: ['api_key'],
      secretIds: { api_key: secretId },
      project: source.project,
      updatedAt: new Date(),
    },
  },
  { upsert: true },
);
console.log(`\nwrote credential record for ${CUSTOM_ID} → ${secretId}`);
process.exit(0);
