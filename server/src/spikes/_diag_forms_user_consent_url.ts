/**
 * Generate ONE real Microsoft sign-in link for Microsoft Forms' new delegated (userAuth) path,
 * using the real stored tenant_id/client_id for the "ConnectorsTest" Azure app — the same app
 * already used for shared_microsoftforms' (removed) app-only attempt.
 *
 * This does NOT complete the flow. It only proves whether Microsoft's authorize endpoint
 * accepts the request shape at all (redirect_uri registered, scope well-formed) before a
 * human clicks through and grants (or is refused) consent. Read the printed instructions.
 *
 * Run: npx tsx src/spikes/_diag_forms_user_consent_url.ts
 */
const { getSaToken } = await import('../auth/google.js');
const { startUserConsent } = await import('../services/userConnectorAuth.js');
const { config } = await import('../config.js');

const PROJECT = 'agentmigrations';
const SCOPE_PREFIX = 'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph';
const HOST = 'https://secretmanager.googleapis.com/v1';

async function readSecret(saToken: string, secretId: string): Promise<string> {
  const url = `${HOST}/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

async function main() {
  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);

  const redirectUri = `${config.SERVER_ORIGIN}/api/auth/connector-consent/callback`;

  const { authorizeUrl } = startUserConsent({
    appUserId: 'diag-test',
    tenantId,
    userKey: 'erik@filefuze.co',
    connectorId: 'shared_microsoftforms',
    ownerScope: 'diag-test',
    project: PROJECT,
    redirectUri,
    fields: { client_id: clientId, tenant_id: tenantId },
  });

  console.log('=== Microsoft Forms delegated-consent URL ===\n');
  console.log(authorizeUrl);
  console.log('\n=== Before clicking it ===');
  console.log(
    `1. This app ("ConnectorsTest") must have "${redirectUri}" registered as a valid\n` +
    '   redirect URI (Azure Portal -> App registrations -> ConnectorsTest -> Authentication\n' +
    '   -> Add a platform -> Web -> Redirect URI). If it is missing, Microsoft will show\n' +
    '   AADSTS50011 (redirect_uri mismatch) immediately, before Forms is even reached.\n',
  );
  console.log(
    '2. If the redirect URI is fine, sign in with erik@filefuze.co. Three outcomes matter:\n' +
    '   a) A consent screen naming a Forms permission appears, and accepting it lands on the\n' +
    '      redirect URI with ?code=... in the address bar -> the scope is real and accepted;\n' +
    '      worth finishing the exchange.\n' +
    '   b) Microsoft shows an error naming the scope/resource as invalid (e.g. AADSTS650053\n' +
    '      or "invalid_resource") -> forms.cloud.microsoft/Forms.Read is not a real,\n' +
    '      consentable permission for this app; the delegated path is dead the same way the\n' +
    '      app-only one was.\n' +
    '   c) Consent succeeds but for a DIFFERENT reason (e.g. it silently substitutes a\n' +
    "      first-party Microsoft scope) -> note exactly what the consent screen says.\n",
  );
  console.log('This link embeds a real client_id and is a live grant request — do not share it outside the team.');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
