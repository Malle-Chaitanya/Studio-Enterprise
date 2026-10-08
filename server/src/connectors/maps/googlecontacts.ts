import type { OperationMapEntry, MappedStep } from '../operationMap.js';

/**
 * shared_googlecontacts -> Google People API v1.
 *
 * THIS CONNECTOR IS TWO GENERATIONS AT ONCE, which is why a connector-level verdict was
 * always wrong for it. Of its 12 operations:
 *
 *   4  address the GData Contacts API (`/m8/feeds/...`), which Google RETIRED in 2022.
 *      Perfect path shape, nothing behind it.
 *   5  address the People API, but through Power Platform version prefixes — `/v4/people/
 *      v1/me/connections`, `/v2/people/people:createContact` — that are Microsoft's
 *      connector versioning, not Google's.
 *   3  are polling triggers, which no vendor API serves.
 *
 * So the live People operations and the dead GData ones need the SAME mapping target and
 * neither can be derived from its path. Both are mapped here: a retired API is still an
 * operation the customer's agent calls, and migrating it to the live equivalent is strictly
 * better than reproducing a path that has been dead for years.
 *
 * `personFields` is sent explicitly on every read. People v1 returns an error without it,
 * and the connector's callers expect the common contact fields, so the mapping names them
 * rather than leaving the model to guess a field mask it has no way to know.
 */

const CONTACT_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses';

function contacts(operationId: string, steps: MappedStep[], notes?: string[]): OperationMapEntry {
  return { connectorId: 'shared_googlecontacts', operationId, api: 'people', steps, notes, provenance: 'drafted' };
}

const NOTE_GDATA =
  'The original operation called the GData Contacts API, which Google retired in 2022 — it '
  + 'could not have worked. Mapped to the People API equivalent, whose response shape is '
  + 'entirely different (resourceName, names[], emailAddresses[]).';
const NOTE_FIELD_MASK =
  `Returns ${CONTACT_FIELDS}. People v1 requires an explicit field mask, so anything outside `
  + 'that set is absent where the connector returned a whole contact.';

/** The list-connections step, shared by the four operations that mean "list my contacts".
 *  `{peopleId}` is the placeholder Discovery's flatPath uses for the `resourceName`
 *  parameter — see the URL-placeholder check in verifyMapEntry. */
const LIST_CONNECTIONS: MappedStep = {
  vendorMethodId: 'people.people.connections.list',
  parameters: [
    { to: 'peopleId', in: 'path', template: 'me' },
    { to: 'personFields', in: 'query', template: CONTACT_FIELDS },
  ],
};

const LIST_GROUPS: MappedStep = {
  vendorMethodId: 'people.contactGroups.list',
  parameters: [{ to: 'groupFields', in: 'query', template: 'name,groupType,memberCount' }],
};

export const GOOGLE_CONTACTS_MAP: OperationMapEntry[] = [
  // People API operations, behind Power Platform version prefixes.
  contacts('PeopleApiListContactsV3', [LIST_CONNECTIONS], [NOTE_FIELD_MASK]),
  contacts('PeopleApiListContactsV4', [LIST_CONNECTIONS], [NOTE_FIELD_MASK]),
  contacts('PeopleApiListGroupsV2', [LIST_GROUPS]),

  // GData operations — dead at the vendor, mapped to the live equivalent.
  contacts('ListContacts', [LIST_CONNECTIONS], [NOTE_GDATA, NOTE_FIELD_MASK]),
  contacts('ListContactsV2', [LIST_CONNECTIONS], [NOTE_GDATA, NOTE_FIELD_MASK]),
  contacts('ListGroups', [LIST_GROUPS], [NOTE_GDATA]),
];

export const GOOGLE_CONTACTS_UNMAPPABLE: Record<string, string> = {
  CreateContact: 'People v1 createContact takes a Person body whose shape differs entirely from GData\'s; needs body-template support.',
  PeopleApiCreateContactV2: 'People v1 createContact takes a Person body; needs body-template support.',
  PeopleApiCreateContactV3: 'People v1 createContact takes a Person body; needs body-template support.',
  OnContactUpdated: 'A Power Platform polling trigger. No vendor API serves it — the platform polls and raises the event itself.',
  PeopleApiOnContactUpdatedV2: 'A Power Platform polling trigger; no vendor equivalent.',
  PeopleApiOnContactUpdatedV3: 'A Power Platform polling trigger; no vendor equivalent.',
};
