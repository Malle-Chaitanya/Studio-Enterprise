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
  /**
   * The HTTP header the credential value goes under. Defaults to 'Authorization' when
   * omitted — every connector above this comment relies on that default. A few vendors
   * (BigCommerce's X-Auth-Token, Pivotal Tracker's X-TrackerToken, VirusTotal's x-apikey)
   * use a different header name for the exact same single-credential shape.
   */
  authHeaderName?: string;
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
     *
     * 'google-dwd-subject' carries no header at all: domain-wide delegation names the person
     * when the TOKEN is minted (`with_subject`), so the caller is applied once in
     * `_mint_token` and every Google tool inherits it — reads and writes alike. It also needs
     * no identity map: the ADK session's user_id already IS a Google address, which is what
     * DWD wants as a subject. (Outlook is the opposite case — the caller arrives as a Google
     * address and has to be mapped back to a Microsoft one first.)
     */
    resolve: 'dataverse-systemuser' | 'graph-user-path' | 'google-dwd-subject';
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
  // One customer-owned service account key, shared by every Google-side destination
  // connector (Drive, Gmail, Calendar today; any future one lands here too) — same
  // reasoning as ms_graph/atlassian above: DWD authorizes ONE service account Client ID
  // for MULTIPLE scopes at once, so asking for the same JSON key three times under three
  // unrelated-looking cards was pure repeated friction, not a real security boundary.
  // Confirmed 2026-08-31: before this, shared_gmail had ZERO credential rows ever saved
  // by any customer in this system's history — the standalone-card model this replaces
  // never actually got used successfully even once.
  //
  // What stays PER-CONNECTOR, deliberately not folded into this group: each connector's
  // own `scope` (drive / gmail.modify / calendar — genuinely different, all authorized
  // under the same Client ID in one Workspace-admin DWD entry), and WHO the agent
  // impersonates (a per-agent fact — Drive's own "acts as X" screen, or the surface-choice
  // email field for Gmail/Calendar — never a tenant-wide default here).
  google_service_account: {
    id: 'google_service_account',
    name: 'Google Cloud (one service account)',
    setupUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    setupHint:
      'Create ONE service account in your OWN Google Cloud project (not CloudFuze\'s), then ' +
      'authorize its Client ID for domain-wide delegation in your Workspace admin console with ' +
      'every scope listed below, across every Google connector you use — Drive, Gmail, ' +
      'Calendar. One key, one DWD authorization, reused by all of them. WHICH person each ' +
      'agent acts as is set per-agent, not here.',
    credentials: [
      { key: 'service_account_json', label: 'Service Account JSON key (your own project)', type: 'password',
        placeholder: '{"type":"service_account","project_id":...}',
        hint: 'Google Cloud Console -> IAM & Admin -> Service Accounts -> Create Service Account (in your own project) -> Keys -> Add key (JSON). Paste the whole file. Authorize its Client ID for domain-wide delegation with the scope(s) each connector below states.' },
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
    // Microsoft's real Power Apps connector id has a hyphen ('shared_service-now') — this
    // entry was previously keyed 'shared_servicenow' (no hyphen), which never matched any
    // real agent's connector id, so this entry was silently unreachable in production
    // despite being fully correct. Confirmed via the live captured connector registry
    // (db/repos/connectorRegistry.ts) — Microsoft's own id is 'shared_service-now'.
    id: 'shared_service-now',
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
    credentials: [], // supplied by the google_service_account credential group
    credentialGroup: 'google_service_account',
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
    // Applied only when the SOURCE Copilot connector ran in invoker mode. `impersonate_email`
    // above pins one person per agent, which is right for a maker connector; an invoker one
    // ran as whoever was asking, so the subject has to follow the caller instead. Every Drive
    // tool inherits it from the token, including create/update/delete — a file the agent
    // writes then lands in the asker's Drive rather than one shared account's.
    impersonation: { header: '', resolve: 'google-dwd-subject' },
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
      'Uses the same service account key as your other Google connectors (see the Google Cloud ' +
      'credential group). Authorize its Client ID for domain-wide delegation with THIS scope too ' +
      '— NOTE: scope strings are matched EXACTLY, granting a broader scope such as mail.google.com ' +
      'does NOT satisfy gmail.modify. WHICH mailbox each agent reads is set per-agent on the next screen.',
    credentials: [], // supplied by the google_service_account credential group
    credentialGroup: 'google_service_account',
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
    // See the Drive note above. This matters more here than anywhere else: `gmail.modify`
    // includes SEND, so without the caller as subject a migrated invoker agent would send
    // mail FROM the one impersonated account no matter who asked it to.
    impersonation: { header: '', resolve: 'google-dwd-subject' },
  },

  {
    id: 'shared_googlecalendar',
    name: 'Google Calendar',
    category: 'storage',
    icon: '📅',
    docsUrl: 'https://developers.google.com/workspace/calendar/api/v3/reference',
    requiredPermissions: ['https://www.googleapis.com/auth/calendar'],
    // CROSS-VENDOR, the third one after shared_gmail and shared_googlechat: the Google
    // destination for Copilot's Office 365 Outlook Calendar operations. Confirmed officially
    // 2026-08-31 (Google's own Calendar API v3 reference): events.insert/events.list/
    // freebusy.query all exist and need nothing beyond this one scope — the gap this fills
    // was purely an unbuilt module (connector_tools/calendar.py), never a platform limit.
    //
    // Same connector id (shared_office365) as Outlook mail on the SOURCE side, but a
    // genuinely separate DECISION from mail — a customer may want mail kept on Microsoft
    // while calendar moves to Google, or the reverse. See
    // db/repos/agentSurfaceChoice.ts's `shared_office365:calendar` composite surface key.
    permissionsHint:
      'Uses the same service account key as your other Google connectors (see the Google Cloud ' +
      'credential group). Authorize its Client ID for domain-wide delegation with THIS scope too. ' +
      'WHICH calendar each agent acts as is set per-agent on the next screen.',
    credentials: [], // supplied by the google_service_account credential group
    credentialGroup: 'google_service_account',
    baseUrlTemplate: 'https://www.googleapis.com/calendar/v3',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'google-service-account',
    scope: 'https://www.googleapis.com/auth/calendar',
  },

  {
    id: 'shared_googlecontacts',
    name: 'Google Contacts',
    category: 'storage',
    icon: '📇',
    docsUrl: 'https://developers.google.com/people/api/rest/v1/people',
    requiredPermissions: ['https://www.googleapis.com/auth/contacts'],
    // CROSS-VENDOR, the fourth after shared_gmail/shared_googlechat/shared_googlecalendar:
    // the Google destination for Copilot's Office 365 Outlook Contacts operations.
    // Confirmed officially 2026-09-01 (Google's own People API reference):
    // people.connections.list/people.get/people.createContact/people.updateContact/
    // contactGroups.list all exist and need nothing beyond this one scope — the gap this
    // fills was purely an unbuilt module (connector_tools/contacts.py), never a platform
    // limit. There is no Keep-Microsoft equivalent yet (no Graph contacts tools exist in
    // connector_tools/outlook.py) — see db/repos/agentSurfaceChoice.ts's
    // 'shared_office365:contacts' entry, which offers only this one target for now.
    permissionsHint:
      'Uses the same service account key as your other Google connectors (see the Google Cloud ' +
      'credential group). Authorize its Client ID for domain-wide delegation with THIS scope too ' +
      '— a SEPARATE grant from gmail.modify and calendar, even if this agent also uses those. ' +
      'WHICH account\'s contacts each agent acts on is set per-agent on the next screen.',
    credentials: [], // supplied by the google_service_account credential group
    credentialGroup: 'google_service_account',
    baseUrlTemplate: 'https://people.googleapis.com/v1',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'google-service-account',
    scope: 'https://www.googleapis.com/auth/contacts',
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
    // "Excel Online (Business)" — a distinct Power Automate connector from `shared_onedrive`,
    // but backed by the SAME Microsoft Graph app-only credential (workbook operations live
    // under Graph's `/drives/{id}/items/{id}/workbook/...`). Added for Agent Flow migration:
    // a real Deal Desk flow (GetRateSheetBand) calls this connector's `GetItems` ("List rows
    // present in a table") operation — see services/flowMapper.ts's GRAPH_OP_BINDINGS.
    id: 'shared_excelonlinebusiness',
    name: 'Excel Online (Business)',
    category: 'productivity',
    icon: '📊',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/excel',
    credentials: [], // supplied by the ms_graph credential group
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Files.Read.All', 'User.Read.All'],
    adminConsentRequired: true,
    permissionsHint: 'This lets the agent read Excel workbook tables from every employee\'s OneDrive/SharePoint in your organization.',
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
    // App-only (above) only ever sees plans belonging to a Microsoft 365 Group the app can
    // enumerate. Proven live 2026-09-24: Sales Profiler Agent's real "Get plan details" tool
    // (plan id s28A16UF90Kuedbwg8h9vWUACvZQ, connectionAuthMode 'invoker' in the source agent)
    // 404s against /planner/plans/{id} with a correctly-granted, correctly-scoped app-only
    // token — the plan genuinely is not visible to the app identity. `/me/planner/plans`
    // (this connector's own captured 'ListMyPlans' operation) makes the shape explicit: it is
    // a delegated, signed-in-user endpoint, and this plan is one only the signed-in person
    // (Erik) can see — most likely a personal, non-group-backed plan. No Graph API permission
    // fixes that; `userAuth` below reproduces the real signed-in-user path instead.
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
    userAuth: {
      authorizeUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
      tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      scope: 'openid email offline_access https://graph.microsoft.com/Tasks.ReadWrite https://graph.microsoft.com/Group.Read.All',
    },
  },

  // ── Tier-2 fallback batch: connectors captured in db/repos/connectorRegistry.ts that
  // had no entry here at all (so a real agent using them migrated with the capability
  // completely gone, not degraded — see docs/2026-09-22 registry-gap finding). Each entry
  // below has ONE unambiguous, publicly documented base URL and a simple auth shape this
  // file's model already supports. Deliberately NOT a bulk pass over the full gap list —
  // per-customer-instance connectors (Basecamp, WordPress) and Azure-ARM-authenticated
  // internal services need a different shape and are tracked separately, not guessed here.

  {
    id: 'shared_pagerduty',
    name: 'PagerDuty',
    category: 'itsm',
    icon: '🚨',
    docsUrl: 'https://developer.pagerduty.com/api-reference/',
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'PagerDuty → Integrations → API Access Keys → Create New API Key' },
    ],
    baseUrlTemplate: 'https://api.pagerduty.com',
    authHeaderTemplate: 'Token token={api_key}',
  },
  {
    id: 'shared_todoist',
    name: 'Todoist',
    category: 'productivity',
    icon: '✅',
    docsUrl: 'https://developer.todoist.com/rest/v2/',
    credentials: [
      { key: 'api_key', label: 'API Token', type: 'password', hint: 'Todoist → Settings → Integrations → Developer → API token' },
    ],
    baseUrlTemplate: 'https://api.todoist.com/rest/v2',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_bitbucket',
    name: 'Bitbucket',
    category: 'devops',
    icon: '🪣',
    docsUrl: 'https://developer.atlassian.com/cloud/bitbucket/rest/intro/',
    credentials: [
      { key: 'username', label: 'Bitbucket Username', type: 'text', hint: 'Your Bitbucket Cloud username' },
      { key: 'app_password', label: 'App Password', type: 'password', hint: 'Bitbucket → Personal settings → App passwords → Create app password' },
    ],
    baseUrlTemplate: 'https://api.bitbucket.org/2.0',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'username',
    basicSecretField: 'app_password',
  },
  {
    id: 'shared_vimeo',
    name: 'Vimeo',
    category: 'content',
    icon: '🎬',
    docsUrl: 'https://developer.vimeo.com/api/reference',
    credentials: [
      { key: 'api_key', label: 'Personal Access Token', type: 'password', hint: 'Vimeo → Developer → My Apps → Generate an access token' },
    ],
    baseUrlTemplate: 'https://api.vimeo.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_bitly',
    name: 'Bitly',
    category: 'marketing',
    icon: '🔗',
    docsUrl: 'https://dev.bitly.com/api-reference',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Bitly → Settings → API → Generic Access Token' },
    ],
    baseUrlTemplate: 'https://api-ssl.bitly.com/v4',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_typeform',
    name: 'Typeform',
    category: 'productivity',
    icon: '📝',
    docsUrl: 'https://developer.typeform.com/get-started/',
    credentials: [
      { key: 'api_key', label: 'Personal Access Token', type: 'password', hint: 'Typeform → My Account → Personal tokens → Generate a new token' },
    ],
    baseUrlTemplate: 'https://api.typeform.com',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_surveymonkey',
    name: 'SurveyMonkey',
    category: 'productivity',
    icon: '🐒',
    docsUrl: 'https://api.surveymonkey.com/v3/docs',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'SurveyMonkey Developer → My Apps → OAuth access token' },
    ],
    baseUrlTemplate: 'https://api.surveymonkey.com/v3',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_pinterest',
    name: 'Pinterest',
    category: 'social',
    icon: '📌',
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Pinterest Developers → My Apps → Generate access token' },
    ],
    baseUrlTemplate: 'https://api.pinterest.com/v5',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_freshservice',
    name: 'Freshservice',
    category: 'itsm',
    icon: '🟢',
    docsUrl: 'https://api.freshservice.com/',
    // Same Freshworks auth convention as shared_freshdesk (also in this file): the API key
    // is sent as the Basic username with a literal 'X' as the password.
    credentials: [
      { key: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'yourcompany', hint: 'The subdomain in your Freshservice URL: yourcompany.freshservice.com' },
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Freshservice → Profile settings → API Key' },
    ],
    baseUrlTemplate: 'https://{subdomain}.freshservice.com/api/v2',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'api_key',
    basicSecretField: 'X',
  },

  // ── Second Tier-2 batch: real Microsoft Graph / Power Platform / Azure DevOps
  // connectors — same verified base hosts and auth pattern already proven for
  // Teams/SharePoint/Outlook/Planner above (Graph) and used directly by this
  // codebase's own live capture code (api.powerapps.com, connectors/captureOpIndex.ts).
  // Deliberately excludes anything retired/deprecated (Skype for Business, Office 365
  // Video, classic Microsoft Graph Security) or whose exact API surface isn't something
  // I can verify with confidence (Microsoft Forms' automation API, Loop, Project Online's
  // per-tenant SharePoint path) — those stay unwired rather than guessed.

  {
    id: 'shared_office365users',
    name: 'Office 365 Users',
    category: 'communication',
    icon: '👤',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/user',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['User.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_office365groups',
    name: 'Office 365 Groups',
    category: 'communication',
    icon: '👥',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/group',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Group.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_office365groupsmail',
    name: 'Office 365 Groups Mail',
    category: 'communication',
    icon: '📧',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/group',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Group.Read.All', 'Mail.Read'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_wordonlinebusiness',
    name: 'Word Online (Business)',
    category: 'productivity',
    icon: '📄',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/onedrive',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Files.ReadWrite.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_onenote',
    name: 'OneNote (Business)',
    category: 'productivity',
    icon: '📓',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/onenote-api-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Notes.ReadWrite.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_todo',
    name: 'Microsoft To-Do (Business)',
    category: 'productivity',
    icon: '✅',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/todo-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Tasks.ReadWrite'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_todoconsumer',
    name: 'Microsoft To-Do (Consumer)',
    category: 'productivity',
    icon: '✅',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/todo-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Tasks.ReadWrite'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_microsoftbookings',
    name: 'Microsoft Bookings',
    category: 'productivity',
    icon: '📅',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/bookings-api-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Bookings.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_shifts',
    name: 'Shifts for Microsoft Teams',
    category: 'communication',
    icon: '🕒',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/schedule',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Schedule.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_m365messagecenter',
    name: 'Microsoft 365 message center',
    category: 'productivity',
    icon: '📢',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/serviceannouncement-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['ServiceMessage.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_azuread',
    name: 'Microsoft Entra ID',
    category: 'identity',
    icon: '🔑',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/directory-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['User.Read.All', 'Group.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_azureadip',
    name: 'Microsoft Entra ID Protection',
    category: 'identity',
    icon: '🛡️',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/identityprotection-root',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['IdentityRiskyUser.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },

  // Power Platform admin API — the SAME host this codebase's own live capture code
  // already calls directly (connectors/captureOpIndex.ts: POWERAPPS_AUDIENCE, the
  // api.powerapps.com URL) — not a guess, a fact already proven live in this project.
  {
    id: 'shared_powerappsforadmins',
    name: 'Power Apps for Admins',
    category: 'productivity',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/powerappsforadmins/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerapps.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.powerapps.com/.default',
  },
  {
    id: 'shared_powerappsforappmakers',
    name: 'Power Apps for Makers',
    category: 'productivity',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/powerappsforappmakers/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerapps.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.powerapps.com/.default',
  },
  {
    id: 'shared_powerappsnotification',
    name: 'Power Apps Notification',
    category: 'productivity',
    icon: '🔔',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/powerappsnotification/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerapps.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.powerapps.com/.default',
  },
  {
    id: 'shared_powerappsnotificationv2',
    name: 'Power Apps Notification V2',
    category: 'productivity',
    icon: '🔔',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/powerappsnotificationv2/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerapps.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.powerapps.com/.default',
  },
  {
    id: 'shared_powerplatformforadmins',
    name: 'Power Platform for Admins',
    category: 'productivity',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/powerplatformforadmins/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerplatform.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.powerplatform.com/.default',
  },

  {
    id: 'shared_visualstudioteamservices',
    name: 'Azure DevOps',
    category: 'devops',
    icon: '🔷',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/azure/devops/',
    // Azure DevOps' REST API takes the Personal Access Token as the Basic PASSWORD with
    // an EMPTY username — omitting basicUserField lets it default to "" (see adk_deploy.py:
    // basic_user_field = conn.get("basicUserField") or "").
    credentials: [
      { key: 'organization', label: 'Organization', type: 'text', placeholder: 'yourorg', hint: 'The organization in your Azure DevOps URL: dev.azure.com/yourorg' },
      { key: 'pat', label: 'Personal Access Token', type: 'password', hint: 'Azure DevOps → User settings → Personal access tokens → New Token' },
    ],
    baseUrlTemplate: 'https://dev.azure.com/{organization}',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicSecretField: 'pat',
  },

  // ── Third Tier-2 batch: Azure's own data-plane services. Each authenticates with a
  // standard Azure AD app-only token scoped to that service's own documented resource id
  // (the same oauth2-client-credentials shape already used above for Graph/PowerApps) —
  // not a guess, this is Microsoft's own documented pattern for every one of these
  // services. The account/namespace/vault name is a customer-supplied credential field,
  // same mechanism as Twilio's account_sid earlier in this file.

  {
    id: 'shared_arm',
    name: 'Azure Resource Manager',
    category: 'azure',
    icon: '☁️',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/resources/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_azureblob',
    name: 'Azure Blob Storage',
    category: 'azure',
    icon: '🗄️',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/storageservices/blob-service-rest-api',
    // Only the storage-specific field is declared here; tenant_id/client_id/client_secret
    // come from the shared ms_graph group, same as every other Microsoft connector above.
    credentials: [
      { key: 'account_name', label: 'Storage Account Name', type: 'text', hint: 'Azure Portal → your Storage Account → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{account_name}.blob.core.windows.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://storage.azure.com/.default',
  },
  {
    id: 'shared_azurequeues',
    name: 'Azure Queues',
    category: 'azure',
    icon: '📬',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/storageservices/queue-service-rest-api',
    credentials: [
      { key: 'account_name', label: 'Storage Account Name', type: 'text', hint: 'Azure Portal → your Storage Account → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{account_name}.queue.core.windows.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://storage.azure.com/.default',
  },
  {
    id: 'shared_azuretables',
    name: 'Azure Table Storage',
    category: 'azure',
    icon: '📊',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/storageservices/table-service-rest-api',
    credentials: [
      { key: 'account_name', label: 'Storage Account Name', type: 'text', hint: 'Azure Portal → your Storage Account → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{account_name}.table.core.windows.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://storage.azure.com/.default',
  },
  {
    id: 'shared_servicebus',
    name: 'Service Bus',
    category: 'azure',
    icon: '🚌',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/servicebus/',
    credentials: [
      { key: 'namespace', label: 'Service Bus Namespace', type: 'text', hint: 'Azure Portal → your Service Bus namespace → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{namespace}.servicebus.windows.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://servicebus.azure.net/.default',
  },
  {
    id: 'shared_eventhubs',
    name: 'Event Hubs',
    category: 'azure',
    icon: '📡',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/eventhub/',
    // Event Hubs runs on the same namespace/protocol stack as Service Bus, hence the
    // identical host shape and AAD resource.
    credentials: [
      { key: 'namespace', label: 'Event Hubs Namespace', type: 'text', hint: 'Azure Portal → your Event Hubs namespace → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{namespace}.servicebus.windows.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://servicebus.azure.net/.default',
  },
  {
    id: 'shared_keyvault',
    name: 'Azure Key Vault',
    category: 'azure',
    icon: '🔐',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/keyvault/',
    credentials: [
      { key: 'vault_name', label: 'Key Vault Name', type: 'text', hint: 'Azure Portal → your Key Vault → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{vault_name}.vault.azure.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://vault.azure.net/.default',
  },
  {
    id: 'shared_azuremonitorlogs',
    name: 'Azure Monitor Logs',
    category: 'azure',
    icon: '📈',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/loganalytics/',
    credentials: [
      { key: 'workspace_id', label: 'Log Analytics Workspace ID', type: 'text', hint: 'Azure Portal → your Log Analytics workspace → Workspace ID' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.loganalytics.io/v1/workspaces/{workspace_id}',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.loganalytics.io/.default',
  },

  // ── Fourth Tier-2 batch. NOT included here, deliberately: the ~15 MCP-kind connectors
  // (a365*, d365*mcpserver, workiq*, cimcp, fabriciqmcpserver, adomcpserver, sentinelmcp,
  // storeoperationsmcpserver, microsoftlearndocsmcpserver) need no registry.ts entry at
  // all — they're handled by the MCP-tool-expansion logic in boundToolSpec.ts, which
  // resolves an MCP server's declared tools directly against ITS OWN underlying
  // connector's real operations (e.g. the Jira MCP Server expands into shared_jira
  // operations). Adding a registry entry for the MCP wrapper id itself would be the
  // wrong fix.

  {
    id: 'shared_dynamicssmbsaas',
    name: 'Dynamics 365 Business Central',
    category: 'business-apps',
    icon: '💼',
    docsUrl: 'https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/devenv-connect-apps-http-request',
    credentials: [
      { key: 'environment_name', label: 'Environment Name', type: 'text', hint: 'Business Central admin center → Environments → the environment name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.businesscentral.dynamics.com/v2.0/{tenant_id}/{environment_name}/api/v2.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.businesscentral.dynamics.com/.default',
  },
  {
    id: 'shared_dynamicsax',
    name: 'Fin & Ops Apps (Dynamics 365)',
    category: 'business-apps',
    icon: '💼',
    docsUrl: 'https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/data-entities/data-entities-data-packages',
    credentials: [
      { key: 'environment', label: 'Environment Host', type: 'text', placeholder: 'yourorg', hint: 'The subdomain in your Finance & Operations URL: yourorg.operations.dynamics.com' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{environment}.operations.dynamics.com/data',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://{environment}.operations.dynamics.com/.default',
  },
  {
    id: 'shared_azureopenai',
    name: 'Azure OpenAI',
    category: 'ai',
    icon: '🤖',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/reference',
    credentials: [
      { key: 'resource_name', label: 'Azure OpenAI Resource Name', type: 'text', hint: 'Azure Portal → your Azure OpenAI resource → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.openai.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_cognitiveservicestextanalytics',
    name: 'Azure Cognitive Service for Language',
    category: 'ai',
    icon: '🧠',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/language-service/',
    credentials: [
      { key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text', hint: 'Azure Portal → your Language resource → name' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_linkedin',
    name: 'LinkedIn',
    category: 'social',
    icon: '💼',
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'LinkedIn Developer → your app → OAuth access token' },
    ],
    baseUrlTemplate: 'https://api.linkedin.com/v2',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_linkedinv2',
    name: 'LinkedIn V2',
    category: 'social',
    icon: '💼',
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'LinkedIn Developer → your app → OAuth access token' },
    ],
    baseUrlTemplate: 'https://api.linkedin.com/v2',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_hellosign',
    name: 'HelloSign',
    category: 'productivity',
    icon: '✍️',
    docsUrl: 'https://developers.hellosign.com/api/reference/',
    // HelloSign/Dropbox Sign sends the API key as the Basic username with a BLANK
    // password — omitting basicSecretField leaves it "" (adk_deploy.py's own default),
    // which the basic-auth builder only treats as a real secret lookup when non-empty.
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'HelloSign → Settings → API → API Key' },
    ],
    baseUrlTemplate: 'https://api.hellosign.com/v3',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'api_key',
  },
  {
    id: 'shared_insightly',
    name: 'Insightly',
    category: 'crm',
    icon: '📇',
    docsUrl: 'https://api.insightly.com/v3.1/Help',
    // Same blank-password convention as HelloSign above.
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Insightly → User Settings → API Key' },
    ],
    baseUrlTemplate: 'https://api.insightly.com/v3.1',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'api_key',
  },
  {
    id: 'shared_smartsheet',
    name: 'Smartsheet',
    category: 'productivity',
    icon: '📋',
    docsUrl: 'https://smartsheet.redoc.ly/',
    credentials: [
      { key: 'api_key', label: 'API Access Token', type: 'password', hint: 'Smartsheet → Account → Apps & Integrations → API Access → Generate new access token' },
    ],
    baseUrlTemplate: 'https://api.smartsheet.com/2.0',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_teamwork',
    name: 'Teamwork Projects',
    category: 'productivity',
    icon: '👷',
    docsUrl: 'https://apidocs.teamwork.com/docs/teamwork/',
    // Teamwork's own convention: API key as Basic username, literal "X" as password —
    // same trick as Freshdesk/Freshservice above.
    credentials: [
      { key: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'yourcompany', hint: 'The subdomain in your Teamwork URL: yourcompany.teamwork.com' },
      { key: 'api_key', label: 'API Token', type: 'password', hint: 'Teamwork → your avatar → Edit My Details → API & Mobile' },
    ],
    baseUrlTemplate: 'https://{subdomain}.teamwork.com',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'api_key',
    basicSecretField: 'X',
  },
  {
    id: 'shared_sparkpost',
    name: 'SparkPost',
    category: 'marketing',
    icon: '📮',
    docsUrl: 'https://developers.sparkpost.com/api/',
    // SparkPost sends the raw API key with NO "Bearer" prefix — its own documented
    // convention, unlike most of the bearer-style connectors above.
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'SparkPost → Account → API Keys → Create API Key' },
    ],
    baseUrlTemplate: 'https://api.sparkpost.com/api/v1',
    authHeaderTemplate: '{api_key}',
  },

  // ── Fifth Tier-2 batch: Azure Resource Manager management-plane services (ALL share
  // the ONE control-plane host below — this is not per-service guessing, ARM really is
  // a single unified REST surface for every Azure resource type), the rest of the
  // Cognitive Services family (same AAD-bearer convention already proven for the
  // Language service above), a few more Microsoft services with their own well-documented
  // dedicated hosts, and — using the authHeaderName plumbing just added — three
  // real third-party vendors whose auth needs a non-Authorization header.

  {
    id: 'shared_aci',
    name: 'Azure Container Instance',
    category: 'azure',
    icon: '📦',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/container-instances/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_acl',
    name: 'Azure Confidential Ledger',
    category: 'azure',
    icon: '📒',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/confidentialledger/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_azureappservice',
    name: 'Azure App Service',
    category: 'azure',
    icon: '🌐',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/appservice/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_azureautomation',
    name: 'Azure Automation',
    category: 'azure',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/automation/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_azuredatafactory',
    name: 'Azure Data Factory',
    category: 'azure',
    icon: '🏭',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/datafactory/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_azurevm',
    name: 'Azure VM',
    category: 'azure',
    icon: '🖥️',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/compute/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_azureeventgrid',
    name: 'Azure Event Grid',
    category: 'azure',
    icon: '⚡',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/eventgrid/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    id: 'shared_defendersoc',
    name: 'Microsoft Defender SOC',
    category: 'security',
    icon: '🛡️',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/defenderforcloud/',
    // This connector's own captured auth resource (db/repos/connectorRegistry.ts) is
    // 'https://management.core.windows.net/' — the classic-era name for the same ARM
    // control plane used above.
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://management.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://management.azure.com/.default',
  },
  {
    // baseUrlTemplate was wrong before 2026-09-24: 'https://api.powerplatform.com' does not
    // serve this connector's real captured path at all (confirmed live: 404 RouteNotFound on
    // both /licensing/environments and /appmanagement/apps). The real, reachable host —
    // proven live against this app's own admin API surface — is api.powerapps.com with the
    // 'Microsoft.PowerApps' provider path, same backend shared_powerappsforadmins uses.
    //
    // Fixing the host does not make "Get apps as administrator" callable app-only, though:
    // Microsoft's own response is a hard 403 ('service principal ... does not have permission
    // to access the path'), proven live against Sales Profiler Agent's real environment id
    // (7f9f87cc-464e-e470-95bb-363b7f227200) with a correctly-scoped, correctly-minted token.
    // This is an AUTHORIZATION rejection of the app identity itself, not a missing Graph API
    // permission — Power Platform admin APIs require the caller to hold real admin rights.
    // Two real ways to get there: assign the app's service principal the "Power Platform
    // Administrator" Entra directory role (broad — tenant-wide admin power, not scoped to
    // this one call), or use `userAuth` below so the call runs as the real signed-in admin,
    // which is what Copilot Studio's own `invoker` connection already did for this tool.
    id: 'shared_powerplatformadminv2',
    name: 'Power Platform for Admins V2',
    category: 'productivity',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/powerplatformforadminsv2/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerapps.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.powerapps.com/.default',
    userAuth: {
      authorizeUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
      tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      scope: 'openid email offline_access https://service.powerapps.com/.default',
    },
  },
  {
    id: 'shared_powervirtualagents',
    name: 'Power Virtual Agents',
    category: 'ai',
    icon: '🤖',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/powervirtualagents/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerplatform.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.powerplatform.com/.default',
  },

  // Cognitive Services family — same AAD-bearer convention already proven above for
  // shared_cognitiveservicestextanalytics, extended to the rest of the family.
  {
    id: 'shared_azuretexttospeech',
    name: 'Azure Text to speech',
    category: 'ai',
    icon: '🗣️',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_azurespeechpronuncia',
    name: 'Azure Speech Pronunciation Assessment',
    category: 'ai',
    icon: '🗣️',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/pronunciation-assessment-tool',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_cognitiveservicescomputervision',
    name: 'Computer Vision API',
    category: 'ai',
    icon: '👁️',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_cognitiveservicescontentmoderator',
    name: 'Content Moderator',
    category: 'ai',
    icon: '🚦',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/content-moderator/',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_cognitiveservicescustomvision',
    name: 'Custom Vision',
    category: 'ai',
    icon: '👁️',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/custom-vision-service/',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_formrecognizer',
    name: 'Azure AI Document Intelligence (form recognizer)',
    category: 'ai',
    icon: '📄',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_faceapi',
    name: 'Face API',
    category: 'ai',
    icon: '🙂',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/overview-identity',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_contentunderstanding',
    name: 'Azure AI Content Understanding',
    category: 'ai',
    icon: '🧠',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },

  // Other Microsoft services with their own well-documented dedicated host.
  {
    id: 'shared_azuremonitorlogsingestion',
    name: 'Azure Monitor Logs Ingestion',
    category: 'azure',
    icon: '📈',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview',
    credentials: [{ key: 'dce_endpoint', label: 'Data Collection Endpoint', type: 'url', hint: 'Azure Portal → your Data Collection Endpoint → Logs ingestion URI' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: '{dce_endpoint}',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://monitor.azure.com/.default',
  },
  {
    id: 'shared_kusto',
    name: 'Azure Data Explorer',
    category: 'azure',
    icon: '🔎',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/data-explorer/kusto/api/rest/',
    credentials: [{ key: 'cluster', label: 'Cluster URL', type: 'url', hint: 'Azure Data Explorer → your cluster → URI, e.g. https://mycluster.region.kusto.windows.net' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: '{cluster}',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://kusto.windows.net/.default',
  },
  {
    id: 'shared_azureiotcentral',
    name: 'Azure IoT Central V3',
    category: 'azure',
    icon: '📡',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/iotcentral/',
    credentials: [{ key: 'app_name', label: 'IoT Central Application Name', type: 'text', hint: 'The subdomain in your app URL: appname.azureiotcentral.com' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{app_name}.azureiotcentral.com/api',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://apps.azureiotcentral.com/.default',
  },
  {
    id: 'shared_flowmanagement',
    name: 'Power Automate Management',
    category: 'productivity',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/flowmanagement/',
    // Captured auth resource (db/repos/connectorRegistry.ts) is
    // 'https://service.flow.microsoft.com/' — the AAD resource id; the actual REST host
    // Power Automate's management API is served from is api.flow.microsoft.com.
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.flow.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.flow.microsoft.com/.default',
  },
  {
    id: 'shared_sharepointembedded',
    name: 'SharePoint Embedded',
    category: 'storage',
    icon: '📂',
    docsUrl: 'https://learn.microsoft.com/en-us/sharepoint/dev/embedded/overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['FileStorageContainer.Selected'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_dynamicsfraudprotect',
    name: 'Dynamics 365 Fraud Protection',
    category: 'business-apps',
    icon: '🛡️',
    docsUrl: 'https://learn.microsoft.com/en-us/dynamics365/fraud-protection/',
    // Base IS the connector's own captured auth resource (db/repos/connectorRegistry.ts):
    // 'https://api.dfp.dynamics.com' — Microsoft's own definition states this directly.
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.dfp.dynamics.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.dfp.dynamics.com/.default',
  },
  {
    id: 'shared_dynamicstranslations',
    name: 'Dynamics Translation Service',
    category: 'business-apps',
    icon: '🌐',
    docsUrl: 'https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/lifecycle-services/lcs-services-api',
    // Base IS the connector's own captured auth resource: 'https://lcsapi.lcs.dynamics.com/'.
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://lcsapi.lcs.dynamics.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://lcsapi.lcs.dynamics.com/.default',
  },
  {
    id: 'shared_powerbi',
    name: 'Power BI',
    category: 'data',
    icon: '📊',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/power-bi/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerbi.com/v1.0/myorg',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://analysis.windows.net/powerbi/api/.default',
  },
  {
    id: 'shared_wdatp',
    name: 'Microsoft Defender ATP',
    category: 'security',
    icon: '🛡️',
    docsUrl: 'https://learn.microsoft.com/en-us/defender-endpoint/api/exposed-apis-list',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.securitycenter.microsoft.com/api',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.securitycenter.microsoft.com/.default',
  },
  {
    id: 'shared_windows365',
    name: 'Windows 365',
    category: 'productivity',
    icon: '🖥️',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/cloudpc',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['CloudPC.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },

  // Real third-party vendors needing the authHeaderName plumbing just added.
  {
    id: 'shared_bigcommerce',
    name: 'BigCommerce',
    category: 'commerce',
    icon: '🛒',
    docsUrl: 'https://developer.bigcommerce.com/docs/rest-management',
    credentials: [
      { key: 'store_hash', label: 'Store Hash', type: 'text', hint: 'BigCommerce → Settings → API Accounts → your store hash' },
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'BigCommerce → Settings → API Accounts → Create API Account' },
    ],
    baseUrlTemplate: 'https://api.bigcommerce.com/stores/{store_hash}/v3',
    authHeaderTemplate: '{api_key}',
    authHeaderName: 'X-Auth-Token',
  },
  {
    id: 'shared_pivotaltracker',
    name: 'Pivotal Tracker',
    category: 'productivity',
    icon: '📌',
    docsUrl: 'https://www.pivotaltracker.com/help/api',
    credentials: [
      { key: 'api_key', label: 'API Token', type: 'password', hint: 'Pivotal Tracker → Profile → My Profile → API Token' },
    ],
    baseUrlTemplate: 'https://www.pivotaltracker.com/services/v5',
    authHeaderTemplate: '{api_key}',
    authHeaderName: 'X-TrackerToken',
  },
  {
    id: 'shared_virustotal',
    name: 'Virus Total',
    category: 'security',
    icon: '🦠',
    docsUrl: 'https://docs.virustotal.com/reference/overview',
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'VirusTotal → your profile → API Key' },
    ],
    baseUrlTemplate: 'https://www.virustotal.com/api/v3',
    authHeaderTemplate: '{api_key}',
    authHeaderName: 'x-apikey',
  },

  // Well-documented third-party APIs, simple bearer/basic under Authorization.
  {
    id: 'shared_eventbrite',
    name: 'Eventbrite',
    category: 'productivity',
    icon: '🎟️',
    docsUrl: 'https://www.eventbrite.com/platform/api',
    credentials: [
      { key: 'api_key', label: 'Private Token', type: 'password', hint: 'Eventbrite → Account Settings → Developer Links → API Keys → Private Token' },
    ],
    baseUrlTemplate: 'https://www.eventbriteapi.com/v3',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_inoreader',
    name: 'Inoreader',
    category: 'content',
    icon: '📰',
    docsUrl: 'https://www.inoreader.com/developers/',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Inoreader Developer → your app → OAuth access token' },
    ],
    baseUrlTemplate: 'https://www.inoreader.com/reader/api/0',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_infusionsoft',
    name: 'Infusionsoft',
    category: 'marketing',
    icon: '📧',
    docsUrl: 'https://developer.keap.com/docs/rest/',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Keap (Infusionsoft) Developer → your app → OAuth access token' },
    ],
    baseUrlTemplate: 'https://api.infusionsoft.com/crm/rest/v1',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_gotowebinar',
    name: 'GoToWebinar',
    category: 'productivity',
    icon: '📽️',
    docsUrl: 'https://goto-developer.logmeininc.com/goto-webinar-developer-guide',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'GoTo Developer → your app → OAuth access token' },
    ],
    baseUrlTemplate: 'https://api.getgo.com/G2W/rest/v2',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_gototraining',
    name: 'GoToTraining',
    category: 'productivity',
    icon: '🎓',
    docsUrl: 'https://goto-developer.logmeininc.com/goto-training-developer-guide',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'GoTo Developer → your app → OAuth access token' },
    ],
    baseUrlTemplate: 'https://api.getgo.com/G2T/rest/v2',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_capsulecrm',
    name: 'Capsule CRM',
    category: 'crm',
    icon: '💊',
    docsUrl: 'https://developer.capsulecrm.com/',
    credentials: [
      { key: 'api_key', label: 'Personal Access Token', type: 'password', hint: 'Capsule → My Preferences → API Tokens → Create new token' },
    ],
    baseUrlTemplate: 'https://api.capsulecrm.com/api/v2',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_buffer',
    name: 'Buffer',
    category: 'marketing',
    icon: '📱',
    docsUrl: 'https://buffer.com/developers/api',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Buffer Developers → your app → Access Token' },
    ],
    baseUrlTemplate: 'https://api.bufferapp.com/1',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_sapodata',
    name: 'SAP OData',
    category: 'business-apps',
    icon: '🔶',
    docsUrl: 'https://help.sap.com/docs/SAP_NETWEAVER_750/68bf513362174d54b58cddec28794093/',
    // No fixed public host exists for a self-hosted SAP system — the customer supplies
    // their own OData service root, same 'base_url' credential-type pattern already used
    // for the Atlassian group above.
    credentials: [
      { key: 'base_url', label: 'SAP OData Service URL', type: 'url', hint: 'Your SAP system’s OData service root, e.g. https://sap.yourcompany.com/sap/opu/odata' },
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
    ],
    baseUrlTemplate: '{base_url}',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'username',
    basicSecretField: 'password',
  },

  // ── Sixth Tier-2 batch: the remaining Graph-backed, Azure, and well-documented
  // third-party connectors I have genuine confidence in. Everything genuinely
  // incompatible with this file's model — databases (no REST surface at all), FTP/SFTP/
  // SMTP (non-HTTP protocols), AWS services (SigV4 signing, a different auth scheme this
  // file doesn't support), Google Sheets/Tasks (need the same DWD/service-account Tier-0
  // code as Drive/Calendar, not a data row), MCP-kind ids, and retired services (HipChat,
  // classic QnA Maker, Skype for Business) — is deliberately left out rather than guessed.

  {
    id: 'shared_excel',
    name: 'Excel',
    category: 'productivity',
    icon: '📗',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/excel',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Files.ReadWrite.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_excelonline',
    name: 'Excel Online (OneDrive)',
    category: 'productivity',
    icon: '📗',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/excel',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Files.ReadWrite.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_outlooktasks',
    name: 'Outlook Tasks',
    category: 'productivity',
    icon: '✅',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/outlooktask',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['Tasks.ReadWrite'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_microsoftschooldatas',
    name: 'Microsoft School Data Sync V2',
    category: 'education',
    icon: '🏫',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/education-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['EduRoster.ReadWrite.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_microsoft365compliance',
    name: 'Microsoft 365 compliance',
    category: 'security',
    icon: '✅',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/security-api-overview',
    credentials: [],
    credentialGroup: 'ms_graph',
    requiredPermissions: ['eDiscovery.Read.All'],
    adminConsentRequired: true,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
  {
    id: 'shared_microsoftflowforadmins',
    name: 'Power Automate for Admins',
    category: 'productivity',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/microsoftflowforadmins/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.flow.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.flow.microsoft.com/.default',
  },
  {
    id: 'shared_logicflows',
    name: 'Logic flows',
    category: 'productivity',
    icon: '⚙️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/logicflows/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.flow.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.flow.microsoft.com/.default',
  },
  {
    id: 'shared_flowpush',
    name: 'Notifications',
    category: 'productivity',
    icon: '🔔',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/flowpush/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.flow.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.flow.microsoft.com/.default',
  },
  {
    id: 'shared_approvals',
    name: 'Standard approvals',
    category: 'productivity',
    icon: '✅',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/approvals/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.flow.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.flow.microsoft.com/.default',
  },
  {
    id: 'shared_uiflow',
    name: 'Desktop flows',
    category: 'productivity',
    icon: '🖱️',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/uiflow/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.powerplatform.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.powerplatform.com/.default',
  },
  {
    id: 'shared_dataflows',
    name: 'Power Query Dataflows',
    category: 'data',
    icon: '🌊',
    docsUrl: 'https://learn.microsoft.com/en-us/power-query/dataflows/overview-dataflows-across-power-platform-dynamics-365',
    // Base IS the connector's own captured auth resource (db/repos/connectorRegistry.ts):
    // 'https://powerquery.microsoft.com'.
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://powerquery.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://powerquery.microsoft.com/.default',
  },
  {
    id: 'shared_documentdb',
    name: 'Azure Cosmos DB',
    category: 'azure',
    icon: '🌌',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/cosmos-db/',
    credentials: [{ key: 'account_name', label: 'Cosmos DB Account Name', type: 'text', hint: 'Azure Portal → your Cosmos DB account → name' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{account_name}.documents.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://{account_name}.documents.azure.com/.default',
  },
  {
    id: 'shared_azuredigitaltwins',
    name: 'Azure Digital Twins',
    category: 'azure',
    icon: '🏗️',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/digital-twins/',
    credentials: [{ key: 'instance_host', label: 'Instance Hostname', type: 'text', hint: 'Azure Portal → your Digital Twins instance → Host name' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{instance_host}',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://digitaltwins.azure.net/.default',
  },
  {
    id: 'shared_azuredatalake',
    name: 'Azure Data Lake',
    category: 'azure',
    icon: '🌊',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/storageservices/data-lake-storage-gen2',
    credentials: [{ key: 'account_name', label: 'Storage Account Name', type: 'text', hint: 'Azure Portal → your Data Lake Storage account → name' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{account_name}.dfs.core.windows.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://storage.azure.com/.default',
  },
  {
    id: 'shared_azureloganalytics',
    name: 'Azure Log Analytics',
    category: 'azure',
    icon: '📈',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/loganalytics/',
    credentials: [{ key: 'workspace_id', label: 'Log Analytics Workspace ID', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.loganalytics.io/v1/workspaces/{workspace_id}',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.loganalytics.io/.default',
  },
  {
    id: 'shared_azureaisearch',
    name: 'Azure AI Search',
    category: 'ai',
    icon: '🔍',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/searchservice/',
    credentials: [{ key: 'service_name', label: 'Search Service Name', type: 'text', hint: 'Azure Portal → your AI Search service → name' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{service_name}.search.windows.net',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://search.azure.com/.default',
  },
  {
    id: 'shared_azureaifoundryinference',
    name: 'Azure AI Foundry Inference',
    category: 'ai',
    icon: '🤖',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-foundry/model-inference/',
    credentials: [{ key: 'resource_name', label: 'AI Foundry Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.services.ai.azure.com/models',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_cognitiveservicesspe',
    name: 'Azure Batch Speech-to-text',
    category: 'ai',
    icon: '🗣️',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription',
    credentials: [{ key: 'resource_name', label: 'Cognitive Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.cognitiveservices.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_azurecommunicationservicessms',
    name: 'Azure Communication Services SMS',
    category: 'azure',
    icon: '💬',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/communication/sms/',
    credentials: [{ key: 'resource_name', label: 'Communication Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.communication.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://communication.azure.com/.default',
  },
  {
    id: 'shared_acssmsevents',
    name: 'Azure Communication Services SMS Events',
    category: 'azure',
    icon: '💬',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/communication/sms/',
    credentials: [{ key: 'resource_name', label: 'Communication Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.communication.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://communication.azure.com/.default',
  },
  {
    id: 'shared_acschat',
    name: 'Azure Communication Chat',
    category: 'azure',
    icon: '💬',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/communication/chat/',
    credentials: [{ key: 'resource_name', label: 'Communication Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.communication.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://communication.azure.com/.default',
  },
  {
    id: 'shared_acsemail',
    name: 'Azure Communication Email',
    category: 'azure',
    icon: '📧',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/communication/email/',
    credentials: [{ key: 'resource_name', label: 'Communication Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.communication.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://communication.azure.com/.default',
  },
  {
    id: 'shared_acsidentity',
    name: 'Azure Communication Services Identity',
    category: 'azure',
    icon: '🪪',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/communication/identity/',
    credentials: [{ key: 'resource_name', label: 'Communication Services Resource Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{resource_name}.communication.azure.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://communication.azure.com/.default',
  },
  {
    id: 'shared_iotcentral',
    name: 'Azure IoT Central V2',
    category: 'azure',
    icon: '📡',
    docsUrl: 'https://learn.microsoft.com/en-us/rest/api/iotcentral/',
    credentials: [{ key: 'app_name', label: 'IoT Central Application Name', type: 'text' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{app_name}.azureiotcentral.com/api',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://apps.azureiotcentral.com/.default',
  },
  {
    id: 'shared_fhirbase',
    name: 'FHIRBase',
    category: 'health',
    icon: '🏥',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/healthcare-apis/fhir/',
    credentials: [{ key: 'fhir_url', label: 'FHIR Service URL', type: 'url', hint: 'Azure Health Data Services → your FHIR service → Service URL' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: '{fhir_url}',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://azurehealthcareapis.com/.default',
  },
  {
    id: 'shared_fhirclinical',
    name: 'FHIRClinical',
    category: 'health',
    icon: '🏥',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/healthcare-apis/fhir/',
    credentials: [{ key: 'fhir_url', label: 'FHIR Service URL', type: 'url', hint: 'Azure Health Data Services → your FHIR service → Service URL' }],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: '{fhir_url}',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://azurehealthcareapis.com/.default',
  },
  {
    id: 'shared_cloudappsecurity',
    name: 'Defender for Cloud Apps',
    category: 'security',
    icon: '☁️',
    docsUrl: 'https://learn.microsoft.com/en-us/defender-cloud-apps/api-introduction',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.security.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.security.microsoft.com/.default',
  },
  {
    id: 'shared_securitycopilot',
    name: 'Microsoft Security Copilot',
    category: 'security',
    icon: '🛡️',
    docsUrl: 'https://learn.microsoft.com/en-us/security-copilot/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.security.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.security.microsoft.com/.default',
  },
  {
    id: 'shared_partnercenterevents',
    name: 'Partner Center Events',
    category: 'business-apps',
    icon: '🤝',
    docsUrl: 'https://learn.microsoft.com/en-us/partner-center/developer/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.partnercenter.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.partnercenter.microsoft.com/.default',
  },
  {
    id: 'shared_partnercenterref',
    name: 'Partner Center Referrals',
    category: 'business-apps',
    icon: '🤝',
    docsUrl: 'https://learn.microsoft.com/en-us/partner-center/developer/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.partnercenter.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.partnercenter.microsoft.com/.default',
  },
  {
    id: 'shared_microsoftpartnercent',
    name: 'Microsoft Partner Center',
    category: 'business-apps',
    icon: '🤝',
    docsUrl: 'https://learn.microsoft.com/en-us/partner-center/developer/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.partnercenter.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://api.partnercenter.microsoft.com/.default',
  },
  {
    id: 'shared_projectonline',
    name: 'Project Online',
    category: 'productivity',
    icon: '📅',
    docsUrl: 'https://learn.microsoft.com/en-us/previous-versions/office/project-server-and-project-online/apps/project-online-csom',
    credentials: [
      { key: 'tenant_name', label: 'SharePoint Tenant Name', type: 'text', placeholder: 'yourcompany', hint: 'The tenant name in your PWA URL: yourcompany.sharepoint.com' },
    ],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://{tenant_name}.sharepoint.com/sites/pwa/_api/ProjectServer',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://{tenant_name}.sharepoint.com/.default',
  },
  {
    id: 'shared_bingsearch',
    name: 'Bing Search',
    category: 'data',
    icon: '🔍',
    docsUrl: 'https://learn.microsoft.com/en-us/bing/search-apis/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.bing.microsoft.com/v7.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    id: 'shared_twitter',
    name: 'X',
    category: 'social',
    icon: '𝕏',
    docsUrl: 'https://developer.x.com/en/docs/x-api',
    credentials: [
      { key: 'api_key', label: 'App-Only Bearer Token', type: 'password', hint: 'X Developer Portal → your app → Keys and tokens → Bearer Token' },
    ],
    baseUrlTemplate: 'https://api.twitter.com/2',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_basecamp',
    name: 'Basecamp 3',
    category: 'productivity',
    icon: '🏕️',
    docsUrl: 'https://github.com/basecamp/bc3-api',
    credentials: [
      { key: 'account_id', label: 'Basecamp Account ID', type: 'text', hint: 'The number in your Basecamp URL: 3.basecamp.com/{account_id}' },
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Basecamp → your integration → OAuth access token' },
    ],
    baseUrlTemplate: 'https://3.basecampapi.com/{account_id}',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_riskiqintelligence',
    name: 'RiskIQ',
    category: 'security',
    icon: '🕵️',
    docsUrl: 'https://api.riskiq.net/api/swagger/',
    credentials: [
      { key: 'api_key', label: 'API Key', type: 'text', hint: 'RiskIQ → Settings → Access Keys' },
      { key: 'api_secret', label: 'API Secret', type: 'password' },
    ],
    baseUrlTemplate: 'https://api.riskiq.net',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'api_key',
    basicSecretField: 'api_secret',
  },

  // ── Seventh Tier-2 batch: last genuinely-confident additions. Beyond this point the
  // remaining gap is deliberately NOT closed with more data rows — see
  // docs/DYNAMIC-CONNECTORS-RESEARCH.md for why (non-REST protocols, AWS signing,
  // retired services, MCP-kind ids handled elsewhere, and connectors with no verifiable
  // public API).
  {
    id: 'shared_adobecommerce',
    name: 'Adobe Commerce',
    category: 'commerce',
    icon: '🛍️',
    docsUrl: 'https://developer.adobe.com/commerce/webapi/rest/',
    credentials: [
      { key: 'base_url', label: 'Store URL', type: 'url', hint: 'Your Adobe Commerce (Magento) store root, e.g. https://store.example.com' },
      { key: 'api_key', label: 'Integration Access Token', type: 'password', hint: 'Adobe Commerce Admin → System → Integrations → your integration → Access Token' },
    ],
    baseUrlTemplate: '{base_url}/rest/V1',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_basecamp2',
    name: 'Basecamp 2',
    category: 'productivity',
    icon: '🏕️',
    docsUrl: 'https://github.com/basecamp/bc3-api',
    credentials: [
      { key: 'account_id', label: 'Basecamp Account ID', type: 'text' },
      { key: 'api_key', label: 'Access Token', type: 'password' },
    ],
    baseUrlTemplate: 'https://basecamp.com/{account_id}/api/v1',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_campfire',
    name: 'Campfire',
    category: 'communication',
    icon: '🏕️',
    docsUrl: 'https://github.com/basecamp/bc3-api',
    // Campfire is Basecamp 3's chat feature — same account and API as shared_basecamp.
    credentials: [
      { key: 'account_id', label: 'Basecamp Account ID', type: 'text' },
      { key: 'api_key', label: 'Access Token', type: 'password' },
    ],
    baseUrlTemplate: 'https://3.basecampapi.com/{account_id}',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_toodledo',
    name: 'Toodledo',
    category: 'productivity',
    icon: '✅',
    docsUrl: 'https://api.toodledo.com/3/',
    credentials: [
      { key: 'api_key', label: 'Access Token', type: 'password', hint: 'Toodledo Developer → your app → OAuth2 access token' },
    ],
    baseUrlTemplate: 'https://api.toodledo.com/3',
    authHeaderTemplate: 'Bearer {api_key}',
  },
  {
    id: 'shared_chatter',
    name: 'Chatter',
    category: 'crm',
    icon: '💬',
    docsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.chatterapi.meta/chatterapi/',
    // Chatter is a feature of the Salesforce REST API itself — same instance, same auth
    // as shared_salesforce above, just a different path.
    credentials: [
      { key: 'instance_url', label: 'Instance URL', type: 'url', placeholder: 'https://yourorg.salesforce.com', hint: 'Your Salesforce org URL' },
      { key: 'client_id', label: 'Consumer Key (Client ID)', type: 'text' },
      { key: 'client_secret', label: 'Consumer Secret', type: 'password' },
    ],
    baseUrlTemplate: '{instance_url}/services/data/v59.0/chatter',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: '{instance_url}/services/oauth2/token',
  },
  {
    id: 'shared_dynamicssmbonprem',
    name: 'Dynamics 365 Business Central (on-premises)',
    category: 'business-apps',
    icon: '💼',
    docsUrl: 'https://learn.microsoft.com/en-us/dynamics-nav/it-pro/webservices/use-soap-web-services',
    // On-premises means there is no fixed public host by definition — the customer
    // supplies their own server's OData root, same pattern as the SAP OData entry above.
    credentials: [
      { key: 'base_url', label: 'OData Service URL', type: 'url', hint: 'Your Business Central server’s OData root, e.g. https://bc.yourcompany.com:7048/BC/ODataV4' },
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Web Service Access Key', type: 'password' },
    ],
    baseUrlTemplate: '{base_url}',
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'username',
    basicSecretField: 'password',
  },

  // shared_microsoftforms has NO app-only (client_credentials) path — proven live
  // (2026-09-23): 403 on the simplest possible call, with a correctly-scoped,
  // correctly-minted token, and confirmed against Microsoft's own official permissions
  // reference that no application (or even documented delegated) Forms permission
  // exists at all. `authKind`/`scope`/`tokenUrlTemplate` above are therefore absent —
  // this connector produces NO Tier-2 tool by default, only what `userAuth` below can
  // reach through a real per-user sign-in.
  //
  // EXPERIMENTAL: the delegated (userAuth) path below is UNVERIFIED — the "Forms.Read"
  // scope comes from third-party reverse-engineering, not Microsoft's own docs (which
  // list none). It may still be rejected if forms.cloud.microsoft only accepts
  // Microsoft's own first-party client id (Copilot Studio's), not a customer-registered
  // third-party app, regardless of user consent. Do not treat this as working until a
  // real person has clicked through the consent link and a real Forms call has
  // succeeded with the resulting token.
  {
    id: 'shared_microsoftforms',
    name: 'Microsoft Forms',
    category: 'productivity',
    icon: '📝',
    docsUrl: 'https://learn.microsoft.com/en-us/microsoft-forms/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://forms.cloud.microsoft',
    authHeaderTemplate: 'Bearer {access_token}',
    userAuth: {
      authorizeUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
      tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      scope: 'https://forms.cloud.microsoft/Forms.Read offline_access',
    },
  },
  // "Human review" — Power Automate's approvals/human-in-the-loop connector, same
  // product family as shared_approvals above (which is what a customer sees as
  // "Standard approvals"), just a newer variant. Not independently verified with its
  // own captured AAD resource (its connectionAuth came back empty), so this reuses the
  // same host/scope already proven for the Standard approvals connector.
  {
    id: 'shared_advancedapprovals',
    name: 'Human review',
    category: 'productivity',
    icon: '✅',
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/advancedapprovals/',
    credentials: [],
    credentialGroup: 'ms_graph',
    baseUrlTemplate: 'https://api.flow.microsoft.com',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://service.flow.microsoft.com/.default',
  },
];

export const REGISTRY_BY_ID = new Map(CONNECTOR_REGISTRY.map((c) => [c.id, c]));
