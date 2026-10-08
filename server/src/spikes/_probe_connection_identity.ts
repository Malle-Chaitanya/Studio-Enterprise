/** WHO authorized the Google connections in this environment?
 *
 * The behavioral gate needs to call Google AS the identity the connector uses. That is the
 * GOOGLE account that clicked "Log in with Google Credentials", which need not be - and
 * usually is not - the Microsoft account that owns the environment. Asking a human produces
 * the Microsoft one; the connection itself knows the real answer.
 *
 * Prints identity metadata only: display name, the account the token belongs to, status.
 * Never a token. Throwaway diagnostic.
 */
import 'dotenv/config';
import { clientCredsToken } from '../auth/microsoft.js';
import { POWERAPPS_AUDIENCE } from '../connectors/captureOpIndex.js';

const envId = process.env.CSGE_ENVIRONMENT_ID!;
const token = await clientCredsToken(process.env.CSGE_TENANT_ID!, POWERAPPS_AUDIENCE);

const url = `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/${envId}/connections?api-version=2016-11-01`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
console.log('HTTP', res.status);
const body = (await res.json()) as any;
const rows: any[] = body.value ?? [];
console.log(`${rows.length} connection(s) in this environment\n`);

const google = rows.filter((r) => /google|gmail/i.test(r.properties?.apiId ?? r.name ?? ''));
for (const r of (google.length ? google : rows).slice(0, 25)) {
  const p = r.properties ?? {};
  const api = String(p.apiId ?? '').split('/').pop();
  console.log(`${String(api).padEnd(26)} ${String(p.statuses?.[0]?.status ?? '?').padEnd(10)} ${p.displayName ?? ''}`);
  console.log(`   created by : ${p.createdBy?.displayName ?? '?'}  <${p.createdBy?.email ?? p.createdBy?.userPrincipalName ?? '?'}>`);
  // The Google side: the account the OAuth token actually belongs to.
  const acct = p.accountName ?? p.connectionParametersSet?.name ?? p.authenticatedUser?.name;
  console.log(`   google acct: ${acct ?? '(not exposed on this row)'}`);
}
process.exit(0);
