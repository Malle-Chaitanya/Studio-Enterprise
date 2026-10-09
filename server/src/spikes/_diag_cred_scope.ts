import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { connectorCredentialScope, connectorFieldScope } from '../services/connectorCredentials.js';
for (const id of ['shared_googledrive','shared_googlecontacts','shared_googlesheet','shared_googletasks','shared_googlecalendar']) {
  const d: any = REGISTRY_BY_ID.get(id);
  const own = (d?.credentials ?? []).map((c: any) => c.key).join(',') || '(none)';
  console.log(id.padEnd(24), 'group=' + (d?.credentialGroup ?? '-'), ' ownFields=' + own,
    ' scope=' + connectorCredentialScope(id),
    ' saFieldScope=' + connectorFieldScope(id, 'service_account_json'));
}
process.exit(0);
