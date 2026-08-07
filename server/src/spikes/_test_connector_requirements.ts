/** The exact payload /connector-requirements builds, without needing a live session.
 *  npx tsx src/spikes/_test_connector_requirements.ts */
import { REGISTRY_BY_ID, CREDENTIAL_GROUPS } from '../connectors/registry.js';
import { connectorCredentialFields, connectorsSharingCredentials } from '../services/connectorCredentials.js';

const ids = ['shared_sharepointonline', 'shared_teams', 'shared_confluence', 'shared_jira', 'shared_hubspot'];
let fail = 0;
for (const id of ids) {
  const def = REGISTRY_BY_ID.get(id)!;
  const group = def.credentialGroup ? CREDENTIAL_GROUPS[def.credentialGroup] : undefined;
  const fields = connectorCredentialFields(id);
  const siblings = connectorsSharingCredentials(id);
  console.log(`\n${def.name} [${id}]`);
  console.log(`  authKind : ${def.authKind ?? 'bearer'}`);
  console.log(`  group    : ${group?.name ?? '(none)'}`);
  console.log(`  fields   : ${fields.map((f) => `${f.key}${f.shared ? ' [shared]' : ''}`).join(', ') || '(none)'}`);
  console.log(`  perms    : ${(def.requiredPermissions ?? []).join(', ') || '(none)'}`);
  console.log(`  consent  : ${!!def.adminConsentRequired}`);
  console.log(`  siblings : ${siblings.join(', ') || '(none)'}`);
  if (fields.length === 0) { console.log('  ✗ NO FIELDS — the card would render nothing to fill in'); fail++; }
}
// Every connector must be answerable: either it has fields, or it is unknown.
console.log(`\n${fail === 0 ? 'OK — every connector exposes credential fields' : `${fail} connector(s) expose no fields`}`);
process.exit(fail ? 1 : 0);
