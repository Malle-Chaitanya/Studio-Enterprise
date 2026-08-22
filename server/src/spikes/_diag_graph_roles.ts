/**
 * What application permissions does our Graph token ACTUALLY carry?
 *
 * `ErrorAccessDenied` from Graph mail is ambiguous — it covers a missing app permission, a
 * missing admin consent, and an Exchange Application Access Policy that scopes the app to
 * certain mailboxes. Guessing between them wastes a round trip with the customer's admin.
 *
 * The token's `roles` claim is the ground truth for the first two: it lists exactly the
 * application permissions that were granted AND consented. A permission added but not
 * consented does not appear. If Mail.ReadWrite is present and mail still 403s, the cause is
 * the third one — an Application Access Policy in Exchange — which is a different fix.
 *
 * Decodes the JWT payload only (no signature check, nothing secret printed).
 *
 *   cd server && npx tsx src/spikes/_diag_graph_roles.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const admin = await getSaToken();

async function secret(name: string): Promise<string> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${admin}` } },
  );
  const j = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}

const tenant = await secret('studio-enterprise-ms-graph-tenant-id');
const clientId = await secret('studio-enterprise-ms-graph-client-id');
const clientSecret = await secret('studio-enterprise-ms-graph-client-secret');

const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  }),
});
const tok = (await res.json()) as { access_token?: string; error_description?: string };
if (!tok.access_token) {
  console.log('FAIL token:', tok.error_description?.slice(0, 200));
  process.exit(0);
}

const payload = JSON.parse(Buffer.from(tok.access_token.split('.')[1], 'base64').toString('utf8')) as {
  roles?: string[]; app_displayname?: string; appid?: string; tid?: string;
};

console.log(`app        : ${payload.app_displayname ?? '(no name)'}`);
console.log(`app id     : ${payload.appid}`);
console.log(`tenant     : ${payload.tid}\n`);

const roles = (payload.roles ?? []).sort();
console.log(`${roles.length} application permission(s) granted AND consented:`);
for (const r of roles) console.log(`   ${r}`);

const NEEDED = ['Mail.ReadWrite', 'Mail.Send'];
const missing = NEEDED.filter((n) => !roles.includes(n));

console.log('\n--- VERDICT ---');
if (missing.length) {
  console.log(`MISSING: ${missing.join(', ')}`);
  console.log('These are not on the token, so they were either not added as APPLICATION');
  console.log('permissions (delegated ones never appear here) or admin consent was not granted.');
  console.log(`Entra portal -> App registrations -> ${payload.app_displayname ?? 'the app'} ->`);
  console.log('API permissions -> Add a permission -> Microsoft Graph -> Application permissions');
  console.log('-> tick Mail.ReadWrite and Mail.Send -> then "Grant admin consent".');
} else {
  console.log('Mail.ReadWrite and Mail.Send ARE both on the token.');
  console.log('So ErrorAccessDenied is NOT a missing permission — the remaining cause is an');
  console.log('Exchange Application Access Policy restricting which mailboxes this app may');
  console.log('touch. Check with:  Get-ApplicationAccessPolicy   (Exchange Online PowerShell)');
  console.log(`and if one exists, scope it to include app id ${payload.appid}.`);
}
process.exit(0);
