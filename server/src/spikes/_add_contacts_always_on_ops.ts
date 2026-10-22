/**
 * Adds Google Contacts' bonus capabilities with NO Microsoft source equivalent — confirmed
 * directly against Microsoft's real connector reference page (re-checked 2026-10-22: no
 * "get one contact", "list contact groups", or "update a contact" action exists there at
 * all) — as `alwaysOnForConnector` rows.
 *
 * update_contact genuinely needs two calls: the People API requires the contact's CURRENT
 * `etag` (an optimistic-concurrency token) on every update — sending a stale or missing one
 * is rejected — so this fetches the contact first, then patches using the etag it just read.
 *
 *   npx tsx src/spikes/_add_contacts_always_on_ops.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_googlecontacts';
const CATALOG_VERSION = 1;
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses';

await connectMongo();

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_contact',
  displayName: 'Get a contact',
  method: 'GET',
  // The connector's own baseUrl is 'https://people.googleapis.com' (NO /v1 — confirmed
  // against the original seed script's connector row), so every path here states /v1
  // itself, same convention as create_contact/get_my_contacts already do.
  path: `/v1/{resourceName}?personFields=${PERSON_FIELDS}`,
  parameters: [{ name: 'resourceName', in: 'path', required: true, type: 'string' }], // e.g. "people/c1234567890"
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/contacts'] },
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'list_contact_groups',
  displayName: 'List contact groups',
  method: 'GET',
  path: '/v1/contactGroups',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/contacts'] },
  response: { resultPath: 'contactGroups' },
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'update_contact',
  displayName: 'Update a contact',
  method: 'PATCH',
  path: '',
  parameters: [
    { name: 'resourceName', in: 'query', required: true, type: 'string' },
    // ALL required, deliberately — not optional-with-an-assumed-default. The executor has
    // no notion of "leave unchanged"; an omitted value would leave the literal text
    // "{givenName}" in the request rather than silently preserving the old one (confirmed
    // by a real test of exactly this case on create_folder). To change only one field, the
    // model is expected to call get_contact first and pass the existing values for the rest
    // — a real, honest UX cost of a fully generic executor with no per-field defaulting,
    // not a silent gap.
    { name: 'givenName', in: 'query', required: true, type: 'string' },
    { name: 'familyName', in: 'query', required: true, type: 'string' },
    { name: 'workEmail', in: 'query', required: true, type: 'string' },
    { name: 'mobilePhoneNumber', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/contacts'] },
  chain: [
    {
      // The People API rejects an update with no etag, or a stale one -- so the CURRENT
      // etag must be read fresh on every call, never cached or guessed.
      method: 'GET',
      urlTemplate: 'https://people.googleapis.com/v1/{resourceName}?personFields=metadata',
      extracts: [{ path: 'etag', bindAs: 'etag' }],
    },
    {
      method: 'PATCH',
      urlTemplate: `https://people.googleapis.com/v1/{resourceName}:updateContact?updatePersonFields=${PERSON_FIELDS}`,
      bodyTemplate: {
        etag: '{etag}',
        names: [{ givenName: '{givenName}', familyName: '{familyName}' }],
        emailAddresses: [{ value: '{workEmail}' }],
        phoneNumbers: [{ value: '{mobilePhoneNumber}' }],
      },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log('Added 3 always-on Contacts operations: get_contact, list_contact_groups, update_contact.');
process.exit(0);
