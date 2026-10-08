/** What scopes does THIS customer's migration need, and which are not granted yet?
 *  Derived from their own connectors, checked against the real grant. Prints a paste-ready
 *  list for the Workspace admin. Never prints a token. Throwaway diagnostic. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { requiredVendorScopes, scopeGaps } from '../services/vendorScopeRequirements.js';
import type { ConnectorOpIndex } from '../connectors/operationBinding.js';

const subject = process.env.CSGE_IMPERSONATE;
if (!subject) { console.error('set CSGE_IMPERSONATE=<a workspace user in the customer domain>'); process.exit(2); }
const ctx: CaptureContext = {
  tenantId: process.env.CSGE_TENANT_ID!,
  environmentId: process.env.CSGE_ENVIRONMENT_ID!,
  scope: `ms-${process.env.CSGE_TENANT_ID}`,
};
const ids = (process.env.CSGE_CONNECTORS ??
  'shared_googledrive,shared_googlesheet,shared_googlecontacts,shared_googlecalendar,shared_googletasks'
).split(',');

const indexes: ConnectorOpIndex[] = [];
for (const id of ids) { const i = await resolveOpIndex(id, ctx); if (i) indexes.push(i); }
const required = requiredVendorScopes(indexes);

const key = JSON.parse(config.GOOGLE_SA_KEY_JSON || readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8'));
async function granted(scope: string): Promise<boolean> {
  try {
    const c = new JWT({ email: key.client_email, key: key.private_key, scopes: [scope], subject });
    return Boolean((await c.authorize()).access_token);
  } catch { return false; }
}

const have: Record<string, string[]> = {};
for (const req of required) {
  have[req.identityProvider] = [];
  for (const s of req.scopes) if (await granted(s)) have[req.identityProvider].push(s);
}

console.log(`customer domain of ${subject}, service account client id ${key.client_id}\n`);
for (const req of required) {
  console.log(`${req.identityProvider}: ${req.scopes.length} scope(s) required by ${Object.keys(req.byConnector).length} connector(s)`);
  for (const [cid, scopes] of Object.entries(req.byConnector)) console.log(`  ${cid.padEnd(26)} ${scopes.join(' ')}`);
}

const gaps = scopeGaps(required, have);
if (!gaps.length) { console.log('\nAll required scopes are granted. Nothing to do.'); process.exit(0); }
for (const g of gaps) {
  console.log(`\n!! ${g.identityProvider}: ${g.missing.length} scope(s) NOT granted`);
  console.log(`   these connectors deploy but cannot authenticate: ${g.affectedConnectors.join(', ')}`);
  console.log('\n   Add at https://admin.google.com/ac/owl/domainwidedelegation');
  console.log(`   client id: ${key.client_id}`);
  console.log(`   append:    ${g.missing.join(',')}`);
}
process.exit(0);
