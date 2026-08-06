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
  /** For 'basic-userpass': which credential field is the user and which the secret. */
  basicUserField?: string;
  basicSecretField?: string;
}

/**
 * The three values every Microsoft Graph connector needs. One Azure App
 * Registration serves Teams, SharePoint, OneDrive, Outlook and Planner, so the
 * customer creates it once and we reuse it — asking three times for the same app
 * would be the UI's mistake, not a real requirement.
 */
const MS_GRAPH_FIELDS: CredentialField[] = [
  { key: 'tenant_id', label: 'Tenant ID', type: 'text',
    hint: 'Azure Portal -> Microsoft Entra ID -> Overview -> Tenant ID' },
  { key: 'client_id', label: 'App (Client) ID', type: 'text',
    hint: 'Azure Portal -> App registrations -> your app -> Application (client) ID' },
  { key: 'client_secret', label: 'Client Secret', type: 'password',
    hint: 'Azure Portal -> App registrations -> Certificates & secrets -> New client secret. Grant the app the Graph application permissions the agent needs, then Grant admin consent.' },
];

export const CONNECTOR_REGISTRY: ConnectorDef[] = [

  // ── CRM ────────────────────────────────────────────────────────────────────

  {
    id: 'shared_hubspot',
    name: 'HubSpot',
    category: 'crm',
    icon: '🟠',
    docsUrl: 'https://developers.hubspot.com/docs/api/overview',
    credentials: [
      { key: 'api_key', label: 'Private App Token', type: 'password',
        placeholder: 'pat-na1-…', hint: 'HubSpot → Settings → Integrations → Private Apps → Create a private app' },
    ],
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
    credentials: [
      { key: 'org_url', label: 'Org URL', type: 'url', placeholder: 'https://yourorg.crm.dynamics.com', hint: 'Power Platform → Environments → your env → Settings → Session details → Web API URL' },
      { key: 'tenant_id', label: 'Tenant ID', type: 'text', hint: 'Azure Portal -> Microsoft Entra ID -> Overview -> Tenant ID' },
      { key: 'client_id', label: 'App (Client) ID', type: 'text', hint: 'Azure Portal -> App registrations -> your app -> Application (client) ID' },
      { key: 'client_secret', label: 'Client Secret', type: 'password', hint: 'Azure Portal -> App registrations -> Certificates & secrets -> New client secret. Grant the app a Dataverse application user role.' },
    ],
    baseUrlTemplate: '{org_url}/api/data/v9.2',
    // Was a pasted access token. The app registration is durable; the runtime does the
    // client_credentials exchange and refreshes on expiry.
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: '{org_url}/.default',
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
    credentials: [
      { key: 'domain', label: 'Atlassian Domain', type: 'text', placeholder: 'yourorg.atlassian.net', hint: 'Your Atlassian Cloud domain' },
      { key: 'email', label: 'Account Email', type: 'text', hint: 'The email of the API user' },
      { key: 'api_key', label: 'API Token', type: 'password', hint: 'Atlassian Account → Security → Create and manage API tokens' },
    ],
    baseUrlTemplate: 'https://{domain}/rest/api/3',
    // Atlassian Basic auth is base64(email:apiToken). The old 'Basic {api_key}' sent the
    // raw token and always 401'd, and the collected email was never used at all.
    authHeaderTemplate: 'Basic {basic_b64}',
    authKind: 'basic-userpass',
    basicUserField: 'email',
    basicSecretField: 'api_key',
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
    credentials: [
      { key: 'service_account_json', label: 'Service Account JSON key', type: 'password',
        placeholder: '{"type":"service_account","project_id":...}',
        hint: 'Google Cloud Console -> IAM & Admin -> Service Accounts -> Keys -> Add key (JSON). Paste the whole file. Share the Drive folders with the service account client_email, or enable domain-wide delegation for org-wide access.' },
      { key: 'impersonate_email', label: 'Impersonate user (optional)', type: 'text',
        placeholder: 'user@yourcompany.com',
        hint: 'Only with domain-wide delegation: the user whose Drive the agent should read.' },
    ],
    baseUrlTemplate: 'https://www.googleapis.com/drive/v3',
    authHeaderTemplate: 'Bearer {access_token}',
    // A pasted access token lasts ~1h and customers cannot mint one. The JSON key is
    // durable: the runtime signs a JWT with it and gets a fresh token as needed.
    authKind: 'google-service-account',
    scope: 'https://www.googleapis.com/auth/drive.readonly',
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
    credentials: [
      {
        key: 'base_url',
        label: 'Atlassian Cloud URL',
        type: 'url' as const,
        placeholder: 'https://yourcompany.atlassian.net',
        hint: 'Your Atlassian Cloud domain (the base URL before /wiki)',
      },
      {
        key: 'email',
        label: 'Account Email',
        type: 'text' as const,
        hint: 'Email of the Atlassian account used for API access',
      },
      {
        key: 'api_token',
        label: 'API Token',
        type: 'password' as const,
        hint: 'id.atlassian.com → Security → API tokens → Create API token',
      },
    ],
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
  // One Azure App Registration covers all of these. They stay in SKIP_CONNECTOR_IDS
  // for the KNOWLEDGE path (SharePoint/OneDrive documents are migrated as data
  // stores, not API calls). These entries serve the ACTION path: an agent that must
  // send a Teams message or read a Planner task calls Graph live.
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
    credentials: MS_GRAPH_FIELDS,
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
    credentials: MS_GRAPH_FIELDS,
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
    credentials: MS_GRAPH_FIELDS,
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
    credentials: MS_GRAPH_FIELDS,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },

  {
    id: 'shared_planner',
    name: 'Microsoft Planner',
    category: 'project',
    icon: '📋',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/planner-overview',
    credentials: MS_GRAPH_FIELDS,
    baseUrlTemplate: 'https://graph.microsoft.com/v1.0',
    authHeaderTemplate: 'Bearer {access_token}',
    authKind: 'oauth2-client-credentials',
    tokenUrlTemplate: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/.default',
  },
];
/** IDs to SKIP — first-party MS connectors handled separately as MS-native. */
export const SKIP_CONNECTOR_IDS = new Set([
  'shared_teams',
  'shared_office365',
  'shared_sharepointonline',
  'shared_onedrive',
  'shared_planner',
  'shared_excelonline',
  'shared_microsoftforms',
  'shared_onenote',
  'shared_visualstudioonline',
  'shared_powerbi',
  'shared_azureblob',
  'shared_azureeventhubs',
  'shared_azureservicebus',
  'shared_azurequeues',
  'shared_azuretables',
  'shared_azuread',
]);

export const REGISTRY_BY_ID = new Map(CONNECTOR_REGISTRY.map((c) => [c.id, c]));
