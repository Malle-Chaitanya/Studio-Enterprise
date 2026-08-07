/** Unit test: credential groups share ONE secret namespace, per-connector fields do not.
 *  npx tsx src/spikes/_test_credential_groups.ts */
import { connectorSecretId, connectorCredentialFields, connectorsSharingCredentials } from '../services/connectorCredentials.js';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('\nMicrosoft connectors share one Azure app:');
const spSecret = connectorSecretId('shared_sharepointonline', 'client_secret');
const teamsSecret = connectorSecretId('shared_teams', 'client_secret');
const plannerTenant = connectorSecretId('shared_planner', 'tenant_id');
check('SharePoint and Teams share client_secret', spSecret === teamsSecret, `${spSecret} vs ${teamsSecret}`);
check('secret id uses the group name', spSecret === 'studio-enterprise-ms-graph-client-secret', spSecret);
check('tenant_id also shared', plannerTenant === 'studio-enterprise-ms-graph-tenant-id', plannerTenant);

console.log('\nAtlassian pair shares one token:');
const cfTok = connectorSecretId('shared_confluence', 'api_token');
const jiraTok = connectorSecretId('shared_jira', 'api_token');
check('Confluence and Jira share api_token', cfTok === jiraTok, `${cfTok} vs ${jiraTok}`);

console.log('\nPer-connector fields stay per-connector:');
const dynOrg = connectorSecretId('shared_dynamicscrmonline', 'org_url');
const dynSecret = connectorSecretId('shared_dynamicscrmonline', 'client_secret');
check('Dynamics org_url is NOT shared', dynOrg === 'studio-enterprise-shared-dynamicscrmonline-org-url', dynOrg);
check('Dynamics client_secret IS shared with Graph', dynSecret === 'studio-enterprise-ms-graph-client-secret', dynSecret);

console.log('\nUngrouped connectors unchanged:');
check('HubSpot keeps its own scope',
  connectorSecretId('shared_hubspot', 'api_key') === 'studio-enterprise-shared-hubspot-api-key');

console.log('\nField lists include group fields:');
const spFields = connectorCredentialFields('shared_sharepointonline').map((f) => f.key);
check('SharePoint exposes tenant/client/secret', ['tenant_id','client_id','client_secret'].every((k) => spFields.includes(k)), spFields.join(','));
check('all three marked shared', connectorCredentialFields('shared_sharepointonline').every((f) => f.shared));

console.log('\nSiblings:');
const sibs = connectorsSharingCredentials('shared_teams');
check('Teams has 4+ Microsoft siblings', sibs.length >= 4, sibs.join(','));
check('Confluence sibling is Jira', connectorsSharingCredentials('shared_confluence').includes('shared_jira'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
