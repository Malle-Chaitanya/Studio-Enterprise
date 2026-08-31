/**
 * Third-party connector registry.
 * Each entry describes a connector the tool can detect in Dataverse PA flows
 * and the credentials needed to call its API from a Gemini agent at runtime.
 *
 * Template placeholders ({api_key}, {subdomain}, etc.) are replaced with
 * values from Secret Manager when building the agent instruction block.
 */

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url';
  placeholder?: string;
  hint?: string;
}

/**
 * How the runtime turns the customer's stored credentials into an Authorization
 * header. Declared per connector so the deployed tool can build the header — and
 * mint/refresh a token where one is needed — instead of expecting the customer to
 * supply something they cannot produce.
 *
 * WHY THIS EXISTS: several connectors originally asked for an "Access Token".
 * Customers cannot generate those (they are minted by an OAuth exchange) and they
 * expire in about an hour, so a pasted token would break the same day. We ask for
 * the durable app credentials instead — client id + secret, or an email + API
 * token pair — and do the token work ourselves, refreshing as needed.
 */
export type AuthKind =
  /** Long-lived token pasted as-is: `Authorization: Bearer <token>`. */
  | 'bearer'
  /** Two values base64'd by US into `Basic base64(user:pass)` — customer never encodes anything. */
  | 'basic-userpass'
  /** Customer supplies a pre-encoded Basic string (legacy/manual; avoid for new connectors). */
  | 'basic-raw'
  /** OAuth2 client_credentials: POST client_id+client_secret to tokenUrl, cache until expiry. */
  | 'oauth2-client-credentials'
  /** OAuth2 refresh_token grant: long-lived refresh token + client id/secret → access token. */
  | 'oauth2-refresh-token'
  /** Google service-account JSON key → signed JWT → access token. */
  | 'google-service-account';

export interface ConnectorDef {
  id: string;               // matches the Power Automate connector API name
  name: string;
  category: string;
  icon: string;
  docsUrl?: string;
  credentials: CredentialField[];
  baseUrlTemplate: string;
  authHeaderTemplate: string; // e.g. "Bearer {api_key}" or "Basic {api_key}"
  /** Defaults to 'bearer' when omitted (a plain long-lived token). */
  authKind?: AuthKind;
  /**
   * Token endpoint for the OAuth kinds. May contain {placeholders} resolved from
   * the stored credentials, e.g. the Microsoft tenant id.
   */
  tokenUrlTemplate?: string;
  /** Scope string sent with the token request, when the provider requires one. */
  scope?: string;
  /**
   * How ONE END USER authorizes this connector for themselves.
   *
   * Separate from `authKind`/`scope` above, which describe the shared app-only credential.
   * The two are different grants of different scopes to different principals and must not be
   * conflated: `oauth2-client-credentials` with `.default` gives the agent tenant-wide
   * access ("Mail.Send lets the agent send email as any mailbox in your organization" —
   * this file's own hint), while the delegated flow below gives it exactly what the signed-in
   * person can already do.
   *
   * Present only for connectors where per-user access is actually reproducible. Its absence
   * is meaningful: it means an `invoker` tool on this connector CANNOT be migrated per-user,
   * and the fidelity note is the final answer rather than a temporary one.
   */
  userAuth?: {
    /** Where the user is sent to consent. May contain {placeholders} from stored credentials. */
    authorizeUrlTemplate: string;
    /** Token + refresh endpoint. Usually the same host as authorize. */
    tokenUrlTemplate: string;
    /**
     * DELEGATED scopes — what this person may do, not what the app may do tenant-wide.
     * Must include whatever the provider requires to issue a refresh token
     * (`offline_access` on Microsoft), or the grant expires in an hour and the agent
     * silently stops working for that user.
     */
    scope: string;
  };
  /**
   * Run as the caller WITHOUT asking them to sign in — the app credential carries a header
   * naming who it is acting for, and the platform applies THAT person's permissions.
   *
   * Strictly better than `userAuth` where it exists, and for a different reason than it
   * looks: consent produces a refresh token that lives in our Secret Manager, expires on its
   * own (~90 days), dies on a password change, and cannot be obtained at all by someone who
   * joins after this tool is decommissioned. Impersonation stores nothing per person, so a
   * migrated agent keeps working for everyone, indefinitely, after we are gone.
   *
   * Verified live 2026-08-31 against Dataverse: an app-only call carrying MSCRMCallerID was
   * refused with "The user with id … has not been assigned any roles. They need a role with
   * the prvReadUser privilege" — the app can read 50 users, acting as that person it cannot.
   * The permissions applied are the IMPERSONATED user's, which is the whole claim.
   *
   * Requires the application user to hold `prvActOnBehalfOfAnotherUser`; without it the call
   * is refused outright rather than silently running as the app.
   */
  impersonation?: {
    /** Request header carrying the impersonated principal. */
    header: string;
    /**
     * How to turn a person into the id that header wants. 'dataverse-systemuser' looks the
     * caller up in the target environment's `systemusers` by email — the id is per
     * environment, so it cannot be resolved once at deploy time and cached forever.
     */
    resolve: 'dataverse-systemuser' | 'graph-user-path';
  };
  /** For 'basic-userpass': which credential field is the user and which the secret. */
  basicUserField?: string;
  basicSecretField?: string;
  /**
   * Connectors that share ONE set of credentials. All five Microsoft Graph
   * connectors are served by a single Azure App Registration, and Confluence and
   * Jira by a single Atlassian API token — so the customer is asked once and the
   * values are stored once, under the group name instead of per connector.
   *
   * WHY: without this the UI asks for the same Azure app five times and writes
   * five copies of the same client secret to Secret Manager. Worse, when a second
   * Microsoft connector shows up on a later migration the customer is asked to
   * re-enter credentials they already gave — when all that is actually needed is
   * adding a permission to the app they already made.
   *
   * A connector may still declare its own `credentials` on top of the group's
   * (e.g. Dynamics needs `org_url`); those stay scoped to that connector.
   */
  credentialGroup?: string;
  /**
   * API permissions/scopes the customer must grant this connector's app, shown as
   * a checklist before Save. Granting the credential is not the same as granting
   * access: a Microsoft client_credentials exchange happily returns a token with
   * no permissions consented, and then every call 403s — a failure that otherwise
   * only surfaces inside a live agent conversation.
   */
  requiredPermissions?: string[];
  /** True when a tenant/org admin must approve the permissions (e.g. Graph admin consent). */
  adminConsentRequired?: boolean;
  /** Human note on what to do if the permission grant is the blocker. */
  permissionsHint?: string;
}

/** Credential fields shared by every connector in a group, asked for exactly once. */
export interface CredentialGroupDef {
  id: string;
  name: string;
  credentials: CredentialField[];
  /** Where the customer creates the app/token. */
  setupUrl?: string;
  setupHint?: string;
}

/**
 * The three values every Microsoft Graph connector needs. One Azure App
 * Registration serves Teams, SharePoint, OneDrive, Outlook and Planner, so the
 * customer creates it once and we reuse it — asking three times for the same app
 * would be the UI's mistake, not a real requirement.
 */
/**
 * Credential groups: one credential set serving several connectors.
 *
 * Microsoft — a single Azure App Registration serves Teams, SharePoint, OneDrive,
 * Outlook and Planner. When a later migration turns up another Microsoft connector
 * we must NOT ask for the app again; we ask only for the extra Graph permission on
 * the app that already exists.
 *
 * Atlassian — one API token serves both Confluence and Jira, since it authenticates
 * the Atlassian account rather than a product.
 */
export const CREDENTIAL_GROUPS: Record<string, CredentialGroupDef> = {
  ms_graph: {
    id: 'ms_graph',
    name: 'Microsoft 365 (one App Registration)',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade',
    setupHint:
      'Create ONE app registration for all Microsoft connectors. Add the permissions listed ' +
      'per connector below as APPLICATION permissions, then click Grant admin consent. ' +
      'If any tool ran as the SIGNED-IN USER in Copilot, that same app also needs the ' +
      "DELEGATED permission shown on that connector, plus this tool's redirect URI added " +
      'under Authentication — application permissions alone cannot act as a person.',
    credentials: [], // filled from MS_GRAPH_FIELDS below
  },
  hubspot: {
    id: 'hubspot',
    name: 'HubSpot (one private app token)',
    setupUrl: 'https://app.hubspot.com/private-apps',
    setupHint:
      'One private app token serves every HubSpot connector. Create it under Settings → ' +
      'Integrations → Private Apps and grant only the CRM scopes the agent needs — the token ' +
      'carries exactly the scopes you tick, so a read-only agent should get read scopes only.',
    credentials: [
      { key: 'api_key', label: 'Private App Token', type: 'password',
        placeholder: 'pat-na1-…', hint: 'HubSpot → Settings → Integrations → Private Apps → Create a private app' },
    ],
  },
  atlassian: {
    id: 'atlassian',
    name: 'Atlassian (one API token)',
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    setupHint:
      'One API token covers Confluence and Jira. The token inherits the permissions of the ' +
      'account that creates it — use a purpose-made account limited to the spaces and projects ' +
      'the agent should see, not a full admin.',
    credentials: [
      { key: 'base_url', label: 'Atlassian Cloud URL', type: 'url',
        placeholder: 'https://yourcompany.atlassian.net',
        hint: 'Your Atlassian Cloud base URL (before /wiki or /jira)' },
      { key: 'email', label: 'Account Email', type: 'text', hint: 'The account the API token belongs to' },
      { key: 'api_token', label: 'API Token', type: 'password',
        hint: 'id.atlassian.com -> Security -> Create and manage API tokens' },
    ],
  },
};

const MS_GRAPH_FIELDS: CredentialField[] = [
  { key: 'tenant_id', label: 'Tenant ID', type: 'text',
    hint: 'Azure Portal -> Microsoft Entra ID -> Overview -> Tenant ID' },
  { key: 'client_id', label: 'App (Client) ID', type: 'text',
    hint: 'Azure Portal -> App registrations -> your app -> Application (client) ID' },
  { key: 'client_secret', label: 'Client Secret', type: 'password',
    hint: 'Azure Portal -> App registrations -> Certificates & secrets -> New client secret. Grant the app the Graph application permissions the agent needs, then Grant admin consent.' },
  // WHOSE data the Microsoft tools read. App-only Graph reaches every mailbox and chat in the
  // tenant, so the tools refuse to guess and ask for this by name.
  //
  // It was missing, and the failure had no way out: teams.py reads `secret("impersonate_email")`,
  // nothing declared it, so it never entered `secretIds`, the container read an empty string,
  // and every Teams tool answered "No user is configured for this agent — set the Teams user on
  // the connector screen." There was no such field on that screen. Saving the secret by hand did
  // not help either, because nothing referenced it. Confirmed live 2026-08-22.
  //
  // Optional: leave it blank and the Microsoft tools act as the app where that is meaningful
  // (SharePoint sites), and refuse where it is not (Teams chats belong to a person). A per-AGENT
  // mailbox recorded on the connector screen still overrides this — see the surface-mailbox
  // handling in orchestrator.ts, which writes an agent-scoped secret and swaps it into
  // `secretIds` for that agent only. This is the tenant-wide default beneath that.
  { key: 'impersonate_email', label: 'Act as user (email)', type: 'text',
    placeholder: 'person@yourcompany.com',
    hint: 'The Microsoft 365 user whose Teams chats, mail and files the agent reads. Required for Teams; optional for SharePoint. Per-agent choices override this.' },
];

// The Microsoft group's fields are MS_GRAPH_FIELDS, assigned here so the constant
// stays declared once and reused by every Microsoft connector below.
CREDENTIAL_GROUPS.ms_graph.credentials = MS_GRAPH_FIELDS;

export const CONNECTOR_REGISTRY: ConnectorDef[] = [

  // ── CRM ────────────────────────────────────────────────────────────────────

  {
    id: 'shared_hubspot',
    name: 'HubSpot',
    category: 'crm',
    icon: '🟠',
    docsUrl: 'https://developers.hubspot.com/docs/api/overview',
    credentialGroup: 'hubspot',
    credentials: [], // supplied by the hubspot credential group
    requiredPermissions: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read'],
    permissionsHint:
      'A private app token carries exactly the scopes ticked when it was created. Missing a ' +
      'scope returns 403 at inference time, not at save time.',
    baseUrlTemplate: 'https://api.hubapi.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    // The Independent Publisher variant is a SEPARATE connector id in Power Platform,
    // and agents in the field use it (found on "Enterprise Migration Knowledge",
    // 2026-08-07, where it was silently dropped for having no registry entry). It
    // targets the same HubSpot REST API with the same private-app-token auth, so it
    // shares the credential group rather than asking for a second token.
    id: 'shared_hubspotcrmv2',
    name: 'HubSpot CRM V2 (Independent Publisher)',
    category: 'crm',
    icon: '🟠',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    credentialGroup: 'hubspot',
    credentials: [],
    requiredPermissions: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read'],
    permissionsHint:
      'Same private app token as the HubSpot connector. Association endpoints need read scope ' +
      'on BOTH object types involved.',
    baseUrlTemplate: 'https://api.hubapi.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    // The two HubSpot ids agents in the field ACTUALLY use (live census 2026-08-12,
    // ledger 1.10): `shared_hubspotcrm` on the HubSpot Agent and `shared_hubspotsettingsv2`
    // on two agents. Neither had a registry entry, so both were reported unsupported and no
    // tool was ever built — while `shared_hubspot`, which the registry did have, appears in
    // no agent at all. The registry ids were guessed from product names; these are measured.
    id: 'shared_hubspotcrm',
    name: 'HubSpot CRM (Independent Publisher)',
    category: 'crm',
    icon: '🟠',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    credentialGroup: 'hubspot',
    credentials: [],
    requiredPermissions: ['crm.objects.contacts.read', 'crm.objects.companies.read'],
    permissionsHint:
      'Same private app token as every other HubSpot connector — the customer is not asked twice.',
    baseUrlTemplate: 'https://api.hubapi.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    // MEASURED, not guessed. `shared_hubspotcms` was found on a real staged agent by
    // `_diag_connector_census.ts` — an id no hand-written Tier-1 list contained. Without an
    // entry here the connector is reported as unsupported and gets NO TOOL AT ALL, and it was
    // in the worst possible state: `hasDedicatedToolModule` answers TRUE for it (the Python
    // dispatch matches any kind starting "hubspot"), so the pipeline announced that its bound
    // operations were dropped in favour of purpose-built tools while building no spec to
    // carry them. Same class as the other HubSpot ids in ledger 1.10.
    id: 'shared_hubspotcms',
    name: 'HubSpot CMS (Independent Publisher)',
    category: 'crm',
    icon: '🟠',
    docsUrl: 'https://developers.hubspot.com/docs/api/cms/templates',
    credentialGroup: 'hubspot',
    credentials: [],
    // A CMS scope is a DIFFERENT FAMILY from the CRM ones and is not implied by them.
    // Measured 2026-08-21: /content/api/v2/templates answered 403 naming exactly these, and
    // /cms/v3/design-manager/templates does not exist (404).
    requiredPermissions: ['design-manager-access', 'content-editor-access', 'landingpages-read'],
    permissionsHint:
      'CMS access is separate from CRM access. A private app token with the CRM scopes still ' +
      'gets 403 on templates — the app needs one of design-manager-access, ' +
      'content-editor-access or landingpages-read (newer CMS APIs also want `content`). ' +
      'Scopes are fixed when a private app is created, so adding one means issuing a new token.',
    baseUrlTemplate: 'https://api.hubapi.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_hubspotsettingsv2',
    name: 'HubSpot Settings V2 (Independent Publisher)',
    category: 'crm',
    icon: '🟠',
    docsUrl: 'https://developers.hubspot.com/docs/api/settings/account-information-api',
    credentialGroup: 'hubspot',
    credentials: [],
    requiredPermissions: ['oauth'],
    permissionsHint:
      'Account-info endpoints need only the token itself; no CRM object scopes are involved.',
    baseUrlTemplate: 'https://api.hubapi.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_salesforce',
    name: 'Salesforce',
    category: 'crm',
    icon: '☁️',
    docsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/',
    credentials: [
      { key: 'instance_url', label: 'Instance URL', type: 'url', placeholder: 'https://yourorg.salesforce.com', hint: 'Your Salesforce org URL' },
      { key: 'client_id', label: 'Consumer Key (Client ID)', type: 'text', hint: 'Salesforce Setup -> App Manager -> your Connected App -> Manage Consumer Details' },
      { key: 'client_secret', label: 'Consumer Secret', type: 'password', hint: 'Same screen as the Consumer Key. Enable the Client Credentials flow on the Connected App.' },
    ],
    baseUrlTemplate: '{instance_url}/services/data/v59.0',
    // Was a pasted access token: expires in hours and customers cannot mint one. The
    // consumer key/secret are durable; the runtime exchanges them per token expiry.
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: '{instance_url}/services/oauth2/token',
  },

  {
    id: 'shared_dynamicscrmonline',
    name: 'Dynamics 365 CRM Online',
    category: 'crm',
    icon: '💎',
    docsUrl: 'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview',
    credentialGroup: 'ms_graph',
    credentials: [
      { key: 'org_url', label: 'Org URL', type: 'url', placeholder: 'https://yourorg.crm.dynamics.com', hint: 'Power Platform → Environments → your env → Settings → Session details → Web API URL' },
    ],
    baseUrlTemplate: '{org_url}/api/data/v9.2',
    // Was a pasted access token. The app registration is durable; the runtime does the
    // client_credentials exchange and refreshes on expiry.
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: '{org_url}/.default',
    // Same Web API as shared_commondataserviceforapps, so the same delegated scope applies —
    // see the fuller note there. Omitting it here would report an identical `invoker` tool as
    // permanently lost on one connector id and fixable on the other, purely by which id the
    // source agent happened to declare.
    userAuth: {
      authorizeUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
      tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      scope: 'openid email offline_access {org_url}/user_impersonation',
    },
    // PREFERRED over the userAuth block above — see ConnectorDef.impersonation. Consent is
    // kept as the fallback for tenants that have not granted the app prvActOnBehalfOfAnotherUser.
    impersonation: { header: 'MSCRMCallerID', resolve: 'dataverse-systemuser' },
  },

  {
    // THE most-used connector in the test tenant (5 of 12 connector-using agents, ledger
    // 1.10) and it had no entry, because the registry guessed `shared_dynamicscrmonline`
    // from the product name while Copilot Studio actually emits
    // `shared_commondataserviceforapps`. Same Web API, same app-only auth.
    //
    // `org_url` is NOT asked for here: the migration already knows the environment it
    // extracted from, and bound operations carry it as `dataverseOrgUrl` context. Asking an
    // admin to paste a URL we hold would be asking them to re-enter our own data.
    id: 'shared_commondataserviceforapps',
    name: 'Microsoft Dataverse',
    category: 'crm',
    icon: '💠',
    docsUrl: 'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview',
    credentialGroup: 'ms_graph',
    credentials: [],
    requiredPermissions: ['Dataverse user_impersonation (application user in the target environment)'],
    permissionsHint:
      'App-only Dataverse access needs the app registration added as an APPLICATION USER in the ' +
      'target environment with a security role — a Graph permission alone is not enough, and the ' +
      'failure shows up as 401 on the first call, not at save time. For tools that ran as the ' +
      'signed-in user, add Dynamics CRM > user_impersonation as a DELEGATED permission on the ' +
      'same app; each person then connects their own account once, and their own security roles ' +
      'decide what the agent can see for them.',
    baseUrlTemplate: '{org_url}/api/data/v9.2',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: '{org_url}/.default',
    // Delegated equivalent, used when the source tool was Copilot `invoker` — which for
    // Dataverse is the norm, not the exception (194 of 212 tools in the test tenant).
    //
    // `user_impersonation` is Dataverse's ONLY delegated scope: it means "act as this signed-in
    // user", and the user's own security roles then decide what they can read. That is exactly
    // what Copilot did, and it is why an app-only token cannot substitute — app-only sees every
    // record in the environment regardless of who asked.
    //
    // The resource is per-ENVIRONMENT ({org_url}), so this scope is a template resolved at
    // consent time from the environment being migrated. A tenant with two environments needs
    // two consents; one token cannot span them, because Entra issues tokens per resource.
    //
    // NOTE: this is the CUSTOMER's own connector app, not our interactive sign-in. Adding a
    // delegated Dynamics scope to the sign-in is what triggers AADSTS65001 and is still
    // forbidden — see .claude/rules/security-rules.md. The two apps must stay separate.
    userAuth: {
      authorizeUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
      tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      scope: 'openid email offline_access {org_url}/user_impersonation',
    },
    // PREFERRED over the userAuth block above — see ConnectorDef.impersonation. Consent is
    // kept as the fallback for tenants that have not granted the app prvActOnBehalfOfAnotherUser.
    impersonation: { header: 'MSCRMCallerID', resolve: 'dataverse-systemuser' },
  },

  {
    id: 'shared_pipedrive',
    name: 'Pipedrive',
    category: 'crm',
    icon: '🟢',
    docsUrl: 'https://developers.pipedrive.com/docs/api/v1',
    credentials: [
      { key: 'api_key', label: 'API Token', type: 'password', hint: 'Pipedrive → Settings → Personal preferences → API' },
    ],
    baseUrlTemplate: 'https://api.pipedrive.com/v1',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_freshsales',
    name: 'Freshsales',
    category: 'crm',
    icon: '🟡',
    docsUrl: 'https://developers.freshworks.com/crm/api/',
    credentials: [
      { key: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'yourcompany', hint: 'The subdomain in your Freshsales URL: yourcompany.freshsales.io' },
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Freshsales → Settings → API Settings → API Key' },
    ],
    baseUrlTemplate: 'https://{subdomain}.freshsales.io/api',
    authHeaderTemplate: 'Token token={api_key}',
  },

  // ── ITSM ───────────────────────────────────────────────────────────────────

  {
    id: 'shared_servicenow',
    name: 'ServiceNow',
    category: 'itsm',
    icon: '🔴',
    docsUrl: 'https://developer.servicenow.com/dev.do#!/reference/api/tokyo/rest/',
    credentials: [
      { key: 'instance', label: 'Instance Name', type: 'text', placeholder: 'mycompany', hint: 'The subdomain in your ServiceNow URL: mycompany.service-now.com' },
      { key: 'username', label: 'API Username', type: 'text', hint: 'A ServiceNow user with REST API access' },
      { key: 'password', label: 'API Password', type: 'password', hint: 'The password for that user — we encode the Basic header for you' },
    ],
    baseUrlTemplate: 'https://{instance}.service-now.com/api/now',
    // Previously asked the customer to paste base64("user:pass") by hand. Hand-encoding
    // is easy to get wrong and the failure only shows up as a 401 inside a live agent.
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'username',
    basicSecretField: 'password',
  },

  {
    id: 'shared_freshdesk',
    name: 'Freshdesk',
    category: 'itsm',
    icon: '🟢',
    docsUrl: 'https://developers.freshdesk.com/api/',
    credentials: [
      { key: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'yourcompany', hint: 'The subdomain in your Freshdesk URL: yourcompany.freshdesk.com' },
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Freshdesk -> Profile settings -> Your API Key' },
    ],
    baseUrlTemplate: 'https://{subdomain}.freshdesk.com/api/v2',
    // Freshdesk expects base64("<apikey>:X") — the literal X is the password slot.
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'api_key',
    basicSecretField: 'X',
  },

  {
    id: 'shared_zendesk',
    name: 'Zendesk',
    category: 'itsm',
    icon: '🟩',
    docsUrl: 'https://developer.zendesk.com/api-reference/',
    credentials: [
      { key: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'yourcompany', hint: 'The subdomain in your Zendesk URL: yourcompany.zendesk.com' },
      { key: 'email', label: 'Account Email', type: 'text', hint: 'The Zendesk agent email the token belongs to' },
      { key: 'api_key', label: 'API Token', type: 'password', hint: 'Zendesk Admin -> Apps and Integrations -> APIs -> Zendesk API -> Add API token' },
    ],
    baseUrlTemplate: 'https://{subdomain}.zendesk.com/api/v2',
    // Zendesk wants base64("email/token:TOKEN"); the '/token' suffix is appended by the
    // runtime so the customer just supplies their normal email address.
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'email/token',
    basicSecretField: 'api_key',
  },

  // ── Project management ─────────────────────────────────────────────────────

  {
    id: 'shared_jira',
    name: 'Jira / Atlassian',
    category: 'project',
    icon: '🔵',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    credentialGroup: 'atlassian',
    requiredPermissions: ['read:jira-work'],
    permissionsHint: 'The token has the same access as the account that created it — it can read every project that account can see.',
    credentials: [], // supplied by the atlassian credential group
    baseUrlTemplate: '{base_url}/rest/api/3',
    // Atlassian Basic auth is base64(email:apiToken). The old 'Basic {api_key}' sent the
    // raw token and always 401'd, and the collected email was never used at all.
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'email',
    basicSecretField: 'api_token',
  },

  {
    id: 'shared_asana',
    name: 'Asana',
    category: 'project',
    icon: '🔴',
    docsUrl: 'https://developers.asana.com/reference/rest-api-reference',
    credentials: [
      { key: 'api_key', label: 'Personal Access Token', type: 'password', hint: 'Asana → My Profile Settings → Apps → Manage Developer Apps → New Access Token' },
    ],
    baseUrlTemplate: 'https://app.asana.com/api/1.0',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_trello',
    name: 'Trello',
    category: 'project',
    icon: '🟦',
    docsUrl: 'https://developer.atlassian.com/cloud/trello/rest/',
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'text', hint: 'Visit https://trello.com/app-key' },
      { key: 'token', label: 'Token', type: 'password', hint: 'Generate from your Trello API Key page' },
    ],
    baseUrlTemplate: 'https://api.trello.com/1',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_monday',
    name: 'Monday.com',
    category: 'project',
    icon: '🟣',
    docsUrl: 'https://developer.monday.com/api-reference/docs',
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Monday.com → Profile picture → Developers → My Access Tokens' },
    ],
    baseUrlTemplate: 'https://api.monday.com/v2',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  // ── Messaging ──────────────────────────────────────────────────────────────

  {
    id: 'shared_slack',
    name: 'Slack',
    category: 'messaging',
    icon: '💬',
    docsUrl: 'https://api.slack.com/web',
    credentials: [
      { key: 'api_key', label: 'Bot OAuth Token', type: 'password', placeholder: 'xoxb-…', hint: 'Slack App → OAuth & Permissions → Bot User OAuth Token' },
    ],
    baseUrlTemplate: 'https://slack.com/api',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_twilio',
    name: 'Twilio',
    category: 'messaging',
    icon: '📞',
    docsUrl: 'https://www.twilio.com/docs/api',
    credentials: [
      { key: 'account_sid', label: 'Account SID', type: 'text', hint: 'Twilio Console → Dashboard → Account SID' },
      { key: 'api_key', label: 'Auth Token', type: 'password', hint: 'Twilio Console → Dashboard → Auth Token' },
    ],
    baseUrlTemplate: 'https://api.twilio.com/2010-04-01/Accounts/{account_sid}',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'account_sid',
    basicSecretField: 'api_key',
  },

  {
    id: 'shared_intercom',
    name: 'Intercom',
    category: 'messaging',
    icon: '🗨️',
    docsUrl: 'https://developers.intercom.com/docs',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Intercom → Settings → Integrations → Developer Hub → Your App → Authentication → Token' },
    ],
    baseUrlTemplate: 'https://api.intercom.io',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  // ── Storage ────────────────────────────────────────────────────────────────

  {
    id: 'shared_dropbox',
    name: 'Dropbox',
    category: 'storage',
    icon: '📦',
    docsUrl: 'https://www.dropbox.com/developers/documentation',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Dropbox App Console → Generate access token' },
    ],
    baseUrlTemplate: 'https://api.dropboxapi.com/2',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_box',
    name: 'Box',
    category: 'storage',
    icon: '📫',
    docsUrl: 'https://developer.box.com/reference/',
    credentials: [
      { key: 'api_key', label: 'Developer Token / Access Token', type: 'password', hint: 'Box Developer Console → your app → Configuration → Developer Token' },
    ],
    baseUrlTemplate: 'https://api.box.com/2.0',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_googledrive',
    name: 'Google Drive',
    category: 'storage',
    icon: '📁',
    docsUrl: 'https://developers.google.com/drive/api/reference/rest/v3',
    requiredPermissions: ['https://www.googleapis.com/auth/drive'],
    // Deliberately the CUSTOMER'S OWN service account, not CloudFuze's shared one — see
    // docs/connector-architecture-decisions.md §12.4. A shared SA meant the migrated
    // agent's live Drive tool kept depending on CloudFuze's account forever, past the
    // migration itself; the customer revoking that trust (reasonably, once "the
    // migration tool" looks done) would break Drive on an agent they already rely on.
    // With their own SA there is nothing to revoke without breaking their own agent.
    permissionsHint: 'Create this service account in your OWN Google Cloud project (not ours), then turn on domain-wide delegation for its Client ID in your Google Workspace admin console with this scope. One key covers every agent — WHICH person\'s Drive each agent uses is set per-agent, one screen further on, since different agents can belong to different people.',
    // Deliberately just the key — NOT impersonate_email. One service account key is
    // shared across the whole migration (DWD can impersonate anyone in the domain from
    // the same key), but WHICH person's Drive a given agent should use is a per-agent
    // fact, not a per-migration one (Erik's agent needs Erik's Drive, Alex's needs
    // Alex's) — see docs/connector-architecture-decisions.md §12.5. That's collected on
    // a separate per-agent screen (db/repos/agentConnectorIdentity.ts), not here.
    credentials: [
      { key: 'service_account_json', label: 'Service Account JSON key (your own project)', type: 'password',
        placeholder: '{"type":"service_account","project_id":...}',
        hint: 'Google Cloud Console -> IAM & Admin -> Service Accounts -> Create Service Account (in your own project, not CloudFuze\'s) -> Keys -> Add key (JSON). Paste the whole file. Then authorize its Client ID for domain-wide delegation in your Workspace admin console with the scope below.' },
    ],
    baseUrlTemplate: 'https://www.googleapis.com/drive/v3',
    authHeaderTemplate: 'Bearer {access_token}',
    // A pasted access token lasts ~1h and customers cannot mint one. The JSON key is
    // durable: the runtime signs a JWT with it and gets a fresh token as needed.
    authKind: 'google-service-account',
    // 'drive' (not 'drive.readonly') on purpose — confirmed live 2026-08-10 that a
    // Workspace admin authorizing DWD for 'drive' does NOT also authorize the
    // separate 'drive.readonly' scope string (exact-match, not hierarchical), so a
    // customer who only grants the broad scope still needs this to be the same one.
    scope: 'https://www.googleapis.com/auth/drive',
  },

  {
    id: 'shared_gmail',
    name: 'Gmail',
    category: 'storage',
    icon: '✉️',
    docsUrl: 'https://developers.google.com/gmail/api/reference/rest',
    requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'],
    // CROSS-VENDOR. Every other entry in this registry is the destination for the SAME
    // vendor's connector. This one is the Google destination for Microsoft's Office 365
    // Outlook connector — a migrated agent that read Outlook mail gets these tools instead.
    // The per-operation fidelity (folders vs labels, flags vs stars, what is simply lost) is
    // in src/connectors/equivalence.ts, and the customer sees it in the report.
    //
    // Offered per agent, never applied automatically: whether an Outlook agent SHOULD read
    // Gmail is the customer's call, and a mailbox is more sensitive than a file share.
    permissionsHint:
      'Create this service account in your OWN Google Cloud project, then authorize its Client ID for domain-wide delegation in your Workspace admin console with the scope below. NOTE: scope strings are matched EXACTLY — granting a broader scope such as mail.google.com does NOT satisfy gmail.modify. One key covers every agent; WHICH mailbox each agent reads is set per-agent on the next screen.',
    credentials: [
      { key: 'service_account_json', label: 'Service Account JSON key (your own project)', type: 'password',
        placeholder: '{"type":"service_account","project_id":...}',
        hint: 'Google Cloud Console -> IAM & Admin -> Service Accounts -> Create Service Account -> Keys -> Add key (JSON). Paste the whole file.' },
    ],
    baseUrlTemplate: 'https://gmail.googleapis.com/gmail/v1',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'google-service-account',
    // `gmail.modify` covers read, drafts, labels, star, read-state, trash AND send — one
    // scope for all 15 tools. `gmail.readonly` alone leaves the agent half working: the read
    // tools succeed and every write fails at token-mint time, which reads as a code bug
    // rather than a missing grant (confirmed live 2026-08-19).
    // Deliberately NOT mail.google.com: that scope also permits PERMANENT deletion, which no
    // tool here does or should.
    scope: 'https://www.googleapis.com/auth/gmail.modify',
  },

  {
    id: 'shared_googlechat',
    name: 'Google Chat',
    category: 'messaging',
    icon: '💬',
    docsUrl: 'https://developers.google.com/workspace/chat/api/reference/rest',
    requiredPermissions: [
      // Required — the connector does not work without these two.
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/chat.spaces',
      // OPTIONAL, deliberately NOT in `scope`: each unlocks one tool, and including an
      // ungranted one in the token request breaks every other tool. See the note on `scope`.
      'https://www.googleapis.com/auth/chat.memberships.readonly (optional — enables listing space members)',
      'https://www.googleapis.com/auth/chat.spaces.create (optional — enables creating spaces)',
    ],
    // CROSS-VENDOR, the second one after shared_gmail: the Google destination for Microsoft's
    // Teams connector. Per-operation fidelity lives in src/connectors/equivalence.ts.
    //
    // Chat is a HARDER target than Gmail, and not because of the API surface:
    //   - Chat is FLAT. A Team containing many Channels has no equivalent; both collapse to
    //     one Space, so "which team is this channel in" stops having an answer.
    //   - Chat has two identity models. A service account can act as a registered CHAT APP
    //     (which must be a member of every space it touches), or impersonate a user through
    //     domain-wide delegation. Whether DWD works for Chat is UNPROVEN here — Google
    //     documents Chat auth differently from Gmail. The tools are written so the same code
    //     serves both: impersonate_email set = act as that user; unset = act as the app.
    //   - Interactive surfaces do not carry over at all. Posting a card works; a card the
    //     user can click does not, because that needs an app receiving events, and a
    //     deployed agent is a tool CALLER, not a hosted app.
    // MEASURED 2026-08-20, not inferred: DWD reads work as the impersonated person, but
    // message CREATION returns 404 "Google Chat app not found" until the Cloud project has a
    // Chat app configured. Reading and writing therefore have different prerequisites, which
    // the hint has to say or a customer grants the scopes and still cannot post.
    permissionsHint:
      'READING needs the service account Client ID authorized for domain-wide delegation with the scopes below, exactly as written — scope strings are matched EXACTLY. POSTING additionally needs a Chat app configured on the Cloud project (Google Cloud Console -> Chat API -> Configuration). Without it every send returns 404 "Google Chat app not found", however many scopes are granted. Note that once configured, the agent posts AS THE APP and everyone in the space sees that, rather than posting as a person.',
    credentials: [
      { key: 'service_account_json', label: 'Service Account JSON key (your own project)', type: 'password',
        placeholder: '{"type":"service_account","project_id":...}',
        hint: 'Google Cloud Console -> IAM & Admin -> Service Accounts -> Create Service Account -> Keys -> Add key (JSON). Paste the whole file. Enable the Google Chat API on that project.' },
      // Which person the Chat tools act as, through domain-wide delegation. Unset = act as the
      // app, which only sees spaces the app was added to.
      { key: 'impersonate_email', label: 'Act as user (email)', type: 'text',
        placeholder: 'person@yourcompany.com',
        hint: 'The Workspace user whose Chat spaces and messages the agent reads.' },
      // THE WRITE GATE. chat.py withholds chat_send_message, chat_reply_to_message,
      // chat_send_card, chat_update_message and chat_create_space unless this reads true,
      // because message creation returns 404 "Google Chat app not found" until the Cloud
      // project has a Chat app configured (measured 2026-08-20) and a model handed a send tool
      // that always 404s will retry, apologise, and report the failure as its own.
      //
      // The gate was unreachable: chat.py read `secret("chat_app_configured")` and no field
      // declared it, so it could never be set and the five write tools could never appear.
      // Since Microsoft forbids app-only message POSTs outside import, Google Chat is the ONLY
      // path to a working send — which made this the single field standing between the product
      // and any messaging write at all. Found 2026-08-22.
      { key: 'chat_app_configured', label: 'Chat app configured? (true/false)', type: 'text',
        placeholder: 'false',
        hint: 'Set to "true" only after creating a Chat app in the same Google Cloud project (Google Chat API -> Configuration). Until then message-sending tools are withheld, because Chat answers 404 without one.' },
    ],
    baseUrlTemplate: 'https://chat.googleapis.com/v1',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'google-service-account',
    // Read AND write in one grant, mirroring the gmail.modify decision: a half-scoped agent
    // whose reads work and whose writes fail at token-mint time reads as a code bug rather
    // than a missing grant. `chat.spaces` covers listing and creating spaces; `chat.messages`
    // covers reading and posting. Deliberately NOT chat.delete: no tool here deletes a space.
    // EXACTLY the two scopes the always-on tools need, and no more.
    //
    // This list was briefly four. Adding chat.spaces.create and chat.memberships.readonly —
    // both real, both needed by one tool each — broke the connector ENTIRELY: domain-wide
    // delegation refuses the WHOLE token request when any single scope in it is ungranted,
    // so a deployed agent's chat_list_spaces failed with `unauthorized_client` even though
    // its own scope was granted (measured on RE 1580263741172219904).
    //
    // The rule that follows: a connector's `scope` is the minimum its core tools need. An
    // aspirational scope is not forward-looking, it is an outage for every customer who has
    // not granted it yet. Optional capabilities go in requiredPermissions as optional, and
    // their tools report the missing grant themselves.
    scope:
      'https://www.googleapis.com/auth/chat.messages ' +
      'https://www.googleapis.com/auth/chat.spaces',
  },


  {
    id: 'shared_outlook',
    name: 'Outlook (stay on Microsoft 365)',
    category: 'storage',
    icon: '📧',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/message',
    requiredPermissions: ['Mail.ReadWrite', 'Mail.Send'],
    // The OTHER destination for Copilot's Office 365 Outlook connector. Chosen when the
    // agent migrates to Gemini but the mail platform is NOT moving — a phased migration, or
    // a customer who only ever wanted the agent moved. Nothing is translated on this path,
    // so none of the equivalence.ts fidelity notes apply: folders stay folders, flags keep
    // their due dates, categories keep their colours.
    //
    // shared_office365 (the Copilot connector) stays `proxy-only` and unbindable — its
    // swagger describes a Power Platform dataset abstraction. This entry is the Graph
    // rebuild, which is why it is a separate id rather than a binding for that one.
    permissionsHint:
      'In your Entra app registration add the APPLICATION permissions Mail.ReadWrite and Mail.Send (not delegated), then grant admin consent. App-only access reaches every mailbox in the tenant, so WHICH mailbox each agent reads is set per-agent on the next screen.',
    credentials: [], // supplied by the ms_graph credential group
    credentialGroup: 'ms_graph',
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
    // Delegated equivalent, used when the source tool was Copilot `invoker`. offline_access
    // is not optional: without it Microsoft issues no refresh token, the access token dies
    // in an hour, and the tool starts failing for that user with nothing to explain it.
    userAuth: {
      authorizeUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
      tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      // openid+email are not cosmetic: they make the provider return an id_token, which is
      // how completeUserConsent proves the person who consented is the person the token gets
      // filed under. Without them the binding is asserted by whoever built the link.
      scope: 'openid email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read',
    },
    // PREFERRED over the consent block above. A mailbox belongs to exactly one person, so
    // addressing app-only Graph at `/users/{caller}` IS the permission model — there is
    // nothing a delegated token would additionally confine. And unlike consent it stores
    // nothing per person, so a new joiner works immediately and the agent keeps working once
    // this tool is decommissioned.
    //
    // 'graph-user-path' rather than a header: Graph has no act-as header, it scopes by the
    // path segment. Same intent, different transport.
    impersonation: { header: '', resolve: 'graph-user-path' },
  },

  // ── Marketing ──────────────────────────────────────────────────────────────

  {
    id: 'shared_mailchimp',
    name: 'Mailchimp',
    category: 'marketing',
    icon: '🐵',
    docsUrl: 'https://mailchimp.com/developer/marketing/api/',
    credentials: [
      { key: 'data_center', label: 'Data Center', type: 'text', placeholder: 'us21', hint: 'The data center in your Mailchimp API key (e.g. us21 from key-us21)' },
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Mailchimp → Profile → Extras → API keys' },
    ],
    baseUrlTemplate: 'https://{data_center}.api.mailchimp.com/3.0',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_sendgrid',
    name: 'SendGrid',
    category: 'marketing',
    icon: '📨',
    docsUrl: 'https://docs.sendgrid.com/api-reference',
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'SendGrid → Settings → API Keys → Create API Key' },
    ],
    baseUrlTemplate: 'https://api.sendgrid.com/v3',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  // ── Payments ───────────────────────────────────────────────────────────────

  {
    id: 'shared_stripe',
    name: 'Stripe',
    category: 'payments',
    icon: '💳',
    docsUrl: 'https://stripe.com/docs/api',
    credentials: [
      { key: 'api_key', label: 'Secret Key', type: 'password', placeholder: 'sk_live_…', hint: 'Stripe Dashboard → Developers → API keys → Secret key' },
    ],
    baseUrlTemplate: 'https://api.stripe.com/v1',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  // ── DevOps ─────────────────────────────────────────────────────────────────

  {
    id: 'shared_github',
    name: 'GitHub',
    category: 'devops',
    icon: '⚫',
    docsUrl: 'https://docs.github.com/en/rest',
    credentials: [
      { key: 'api_key', label: 'Personal Access Token', type: 'password', hint: 'GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)' },
    ],
    baseUrlTemplate: 'https://api.github.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_gitlab',
    name: 'GitLab',
    category: 'devops',
    icon: '🦊',
    docsUrl: 'https://docs.gitlab.com/ee/api/',
    credentials: [
      { key: 'api_key', label: 'Personal Access Token', type: 'password', hint: 'GitLab → Edit Profile → Access Tokens → Add new token' },
    ],
    baseUrlTemplate: 'https://gitlab.com/api/v4',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  // ── Productivity ───────────────────────────────────────────────────────────

  {
    id: 'shared_confluence',
    name: 'Confluence',
    category: 'productivity',
    icon: '📝',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v1/intro/',
    credentialGroup: 'atlassian',
    requiredPermissions: ['read:confluence-content.all'],
    permissionsHint: 'The token has the same access as the account that created it — it can read every space that account can see.',
    credentials: [], // supplied by the atlassian credential group
    // Space selection comes from the agent's Copilot Studio config (extracted
    // automatically) — the user doesn't enter space keys here.
    baseUrlTemplate: '{base_url}/wiki/rest/api',
    // Was 'Basic [base64({email}:{api_token})]' — prose, not a template. Substituting
    // values left that literal bracket text in the header. The runtime does the
    // base64 now, so the customer supplies email + token and never encodes anything.
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'email',
    basicSecretField: 'api_token',
  },

  {
    id: 'shared_notion',
    name: 'Notion',
    category: 'productivity',
    icon: '⬛',
    docsUrl: 'https://developers.notion.com/reference/intro',
    credentials: [
      { key: 'api_key', label: 'Internal Integration Token', type: 'password', hint: 'Notion → Settings & Members → Connections → Develop or manage integrations → New integration' },
    ],
    baseUrlTemplate: 'https://api.notion.com/v1',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_airtable',
    name: 'Airtable',
    category: 'productivity',
    icon: '🔶',
    docsUrl: 'https://airtable.com/developers/web/api/introduction',
    credentials: [
      { key: 'api_key', label: 'Personal Access Token', type: 'password', hint: 'Airtable → Account → Developer Hub → Personal access tokens → Create token' },
    ],
    baseUrlTemplate: 'https://api.airtable.com/v0',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  {
    id: 'shared_docusign',
    name: 'DocuSign',
    category: 'productivity',
    icon: '✍️',
    docsUrl: 'https://developers.docusign.com/docs/esign-rest-api/',
    credentials: [
      { key: 'account_id', label: 'Account ID', type: 'text', hint: 'DocuSign Admin → Apps and Keys → Account ID' },
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'OAuth 2.0 JWT or Auth Code access token from your DocuSign app' },
    ],
    baseUrlTemplate: 'https://na4.docusign.net/restapi/v2.1/accounts/{account_id}',
    authHeaderTemplate: 'Bearer {api_key}',
  },

  // ── Generic HTTP ───────────────────────────────────────────────────────────

  {
    id: 'shared_http',
    name: 'HTTP / Generic REST',
    category: 'other',
    icon: '🌐',
    credentials: [
      { key: 'base_url', label: 'Base URL', type: 'url', placeholder: 'https://api.example.com', hint: 'The base URL of the target API' },
      { key: 'api_key', label: 'Authorization Header Value', type: 'password', placeholder: 'Bearer your-token-here', hint: 'Full value for the Authorization header (e.g. Bearer <token> or Basic <base64>)' },
    ],
    baseUrlTemplate: '{base_url}',
    authHeaderTemplate: '{api_key}',
  },

  // ── Microsoft 365 (Graph) ────────────────────────
  // One Azure App Registration covers all of these. SharePoint/OneDrive DOCUMENTS
  // still migrate as data stores (knowledgeClassifier.ts's separate knowledge-source
  // path, not this registry) — these entries are for the ACTION/live-tool path: an
  // agent that must send a Teams message, read a Planner task, or call SharePoint's
  // API live (buildLiveConnectorSpecs) calls Graph directly.
  //
  // Auth is client_credentials against the tenant's token endpoint. A customer
  // cannot hand over a Graph access token — those are minted by this exchange and
  // last about an hour — so we take the durable app registration and mint tokens
  // ourselves, refreshing on expiry.

  {
    id: 'shared_teams',
    name: 'Microsoft Teams',
    category: 'messaging',
    icon: '🟣',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview',
    credentials: [], // supplied by the ms_graph credential group
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Chat.ReadWrite.All', 'ChannelMessage.Send', 'Team.ReadBasic.All', 'User.Read.All'],
    adminConsentRequired: true,
    permissionsHint: 'Reading and sending chat messages needs Chat.ReadWrite.All. Posting in a channel needs ChannelMessage.Send.',
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },

  {
    id: 'shared_sharepointonline',
    name: 'SharePoint Online',
    category: 'storage',
    icon: '📂',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/sharepoint',
    credentials: [], // supplied by the ms_graph credential group
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Sites.Read.All', 'Files.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },

  {
    id: 'shared_onedrive',
    name: 'OneDrive',
    category: 'storage',
    icon: '☁️',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/onedrive',
    credentials: [], // supplied by the ms_graph credential group
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Files.Read.All', 'User.Read.All'],
    adminConsentRequired: true,
    permissionsHint: 'This lets the agent read files from every employee\'s OneDrive in your organization.',
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },

  {
    id: 'shared_office365',
    name: 'Office 365 / Outlook',
    category: 'productivity',
    icon: '📧',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview',
    credentials: [], // supplied by the ms_graph credential group
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Mail.Read', 'Mail.Send', 'Calendars.Read'],
    adminConsentRequired: true,
    permissionsHint: 'Mail.Send lets the agent send email as any mailbox in your organization. Use an Exchange Online access policy to limit which mailboxes it can use.',
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
    // Delegated equivalent of the app-only grant above, used when the source tool was
    // Copilot `invoker`. Same connector, different principal: `.default` above lets the
    // agent send as ANY mailbox in the tenant, while these scopes give it exactly what the
    // signed-in person can already do. offline_access is not optional — without it Microsoft
    // issues no refresh token and the credential dies within the hour.
    userAuth: {
      authorizeUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
      tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      // openid+email are not cosmetic: they make the provider return an id_token, which is
      // how completeUserConsent proves the person who consented is the person the token gets
      // filed under. Without them the binding is asserted by whoever built the link.
      scope: 'openid email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read',
    },
    // PREFERRED over the consent block above. A mailbox belongs to exactly one person, so
    // addressing app-only Graph at `/users/{caller}` IS the permission model — there is
    // nothing a delegated token would additionally confine. And unlike consent it stores
    // nothing per person, so a new joiner works immediately and the agent keeps working once
    // this tool is decommissioned.
    //
    // 'graph-user-path' rather than a header: Graph has no act-as header, it scopes by the
    // path segment. Same intent, different transport.
    impersonation: { header: '', resolve: 'graph-user-path' },
  },

  {
    id: 'shared_planner',
    name: 'Microsoft Planner',
    category: 'project',
    icon: '📋',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/planner-overview',
    credentials: [], // supplied by the ms_graph credential group
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Tasks.ReadWrite.All', 'Group.Read.All'],
    adminConsentRequired: true,
    permissionsHint: 'Planner tasks belong to Microsoft 365 Groups, so Group.Read.All is needed to find and read the plans.',
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
];

export const REGISTRY_BY_ID = new Map(CONNECTOR_REGISTRY.map((c) => [c.id, c]));
