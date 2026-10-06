/**
 * Build every Google connector definition from one policy plus generated catalog data.
 *
 * WHY THIS EXISTS. These five entries used to be typed out separately in registry.ts, and
 * typing them separately got three of them wrong in the same way: `shared_googlecalendar`,
 * `shared_googlecontacts` and `shared_googlechat` carried no `impersonation` block. That is
 * not a cosmetic omission — `adk_deploy.py` computes
 * `impersonating = conn.perUser && conn.perUserMode === 'impersonate'` and then applies the
 * caller as the DWD subject only when `impersonationResolve === 'google-dwd-subject'`. With
 * the block missing, an INVOKER agent on Calendar, Contacts or Chat falls through to the
 * pinned `impersonate_email` or fails closed. Drive and Gmail had the block; the other three
 * were simply forgotten, which is what happens to a fact that has to be restated per app.
 *
 * The runtime was never the problem. `_mint_token` keys on registry DATA, never on the
 * connector kind, so it already serves any Google app. Stating the policy once here is the
 * whole fix.
 *
 * WHAT IS AND IS NOT GENERATED. Everything mechanical — name, base URL, docs link — comes
 * from `googleCatalog.ts`, which a generator writes from Google's Discovery service. What
 * stays here is what Google cannot tell us: the credential model, and the per-app prose that
 * was learned by running this against real tenants. Those notes are kept verbatim; they cost
 * measured failures to acquire.
 *
 * ADDING A GOOGLE APP. Add it to `APPS` in `spikes/_gen_google_catalog.ts`, re-run the
 * generator, and decide its DWD scope (see `scope` below). No new registry entry, no new
 * Python module in `scripts/connector_tools/`.
 */
import type { ConnectorDef, CredentialField } from './registry.js';
import { GOOGLE_APPS } from './googleCatalog.js';

/**
 * True of EVERY Google Workspace app, which is the reason a template works here and not for
 * Power Platform connectors generally: those each carry their own auth shape (OAuth, basic,
 * API key, per-connector token endpoints), while every Google app is reached with the same
 * service account, the same bearer header, and the same domain-wide-delegation subject. Only
 * the identity differs per app, and Discovery publishes that.
 */
const GOOGLE_POLICY = {
  credentials: [] as CredentialField[], // supplied by the google_service_account group
  credentialGroup: 'google_service_account',
  authHeaderTemplate: 'Bearer {access_token}',
  // A pasted access token lasts ~1h and customers cannot mint one. The JSON key is durable:
  // the runtime signs a JWT with it and gets a fresh token as needed.
  authKind: 'google-service-account' as const,
  /**
   * Applied only when the SOURCE Copilot connector ran in invoker mode, so this is inert for
   * a maker connector and cannot change its behaviour. Domain-wide delegation names the
   * person when the TOKEN is minted, so every tool on the connector inherits the subject —
   * reads and writes alike. A file the agent creates lands in the ASKER's Drive; mail it
   * sends comes from the asker's mailbox rather than one pinned account.
   */
  impersonation: { header: '', resolve: 'google-dwd-subject' as const },
};

/** The hand-won half: what Google's catalogue cannot state. */
interface GoogleOverride {
  /**
   * The name the CUSTOMER knows this connector by, when Discovery's own title is not it.
   * Discovery titles the People API "People" and the Calendar API "Calendar"; the connectors
   * are "Google Contacts" and "Google Calendar" on every screen the customer has ever seen,
   * and in Power Platform. A generated display name is the one generated field that must
   * defer to the product's vocabulary rather than the vendor's.
   */
  name?: string;
  /** A more specific docs page than Discovery's generic `documentationLink`. */
  docsUrl?: string;
  /** Shown as a checklist before Save. May carry annotated OPTIONAL entries. */
  requiredPermissions?: string[];
  permissionsHint: string;
  /** Replaces the shared credential group when an app needs fields of its own. */
  credentials?: CredentialField[];
  credentialGroup?: string;
}

const OVERRIDES: Record<string, GoogleOverride> = {
  shared_googledrive: {
    docsUrl: 'https://developers.google.com/drive/api/reference/rest/v3',
    requiredPermissions: ['https://www.googleapis.com/auth/drive'],
    // Deliberately the CUSTOMER'S OWN service account, not CloudFuze's shared one — see
    // docs/connector-architecture-decisions.md §12.4. A shared SA meant the migrated agent's
    // live Drive tool kept depending on CloudFuze's account forever, past the migration
    // itself; the customer revoking that trust (reasonably, once "the migration tool" looks
    // done) would break Drive on an agent they already rely on. With their own SA there is
    // nothing to revoke without breaking their own agent.
    //
    // Deliberately NOT collecting impersonate_email here: one key is shared across the whole
    // migration (DWD can impersonate anyone in the domain from the same key), but WHICH
    // person's Drive a given agent uses is a per-AGENT fact, not a per-migration one — see
    // §12.5 and db/repos/agentConnectorIdentity.ts.
    permissionsHint:
      "Create this service account in your OWN Google Cloud project (not ours), then turn on domain-wide delegation for its Client ID in your Google Workspace admin console with this scope. One key covers every agent — WHICH person's Drive each agent uses is set per-agent, one screen further on, since different agents can belong to different people.",
  },

  shared_gmail: {
    docsUrl: 'https://developers.google.com/gmail/api/reference/rest',
    requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'],
    // CROSS-VENDOR. Most entries are the destination for the SAME vendor's connector; this
    // one is the Google destination for Microsoft's Office 365 Outlook connector. A migrated
    // agent that read Outlook mail gets these tools instead. Per-operation fidelity (folders
    // vs labels, flags vs stars, what is simply lost) lives in connectors/equivalence.ts and
    // the customer sees it in the report. Offered per agent, never applied automatically:
    // whether an Outlook agent SHOULD read Gmail is the customer's call, and a mailbox is
    // more sensitive than a file share.
    permissionsHint:
      'Uses the same service account key as your other Google connectors (see the Google Cloud ' +
      'credential group). Authorize its Client ID for domain-wide delegation with THIS scope too ' +
      '— NOTE: scope strings are matched EXACTLY, granting a broader scope such as mail.google.com ' +
      'does NOT satisfy gmail.modify. WHICH mailbox each agent reads is set per-agent on the next screen.',
  },

  shared_googlecalendar: {
    name: 'Google Calendar',
    docsUrl: 'https://developers.google.com/workspace/calendar/api/v3/reference',
    requiredPermissions: ['https://www.googleapis.com/auth/calendar'],
    // CROSS-VENDOR: the Google destination for Copilot's Office 365 Outlook Calendar
    // operations. Confirmed 2026-08-31 against Google's own Calendar API v3 reference —
    // events.insert/events.list/freebusy.query all exist and need nothing beyond this one
    // scope. The gap this fills was an unbuilt module, never a platform limit.
    //
    // Same source connector id (shared_office365) as Outlook mail, but a genuinely separate
    // DECISION: a customer may keep mail on Microsoft while calendar moves to Google, or the
    // reverse. See db/repos/agentSurfaceChoice.ts's `shared_office365:calendar` key.
    permissionsHint:
      'Uses the same service account key as your other Google connectors (see the Google Cloud ' +
      'credential group). Authorize its Client ID for domain-wide delegation with THIS scope too. ' +
      'WHICH calendar each agent acts as is set per-agent on the next screen.',
  },

  shared_googlecontacts: {
    name: 'Google Contacts',
    docsUrl: 'https://developers.google.com/people/api/rest/v1/people',
    requiredPermissions: ['https://www.googleapis.com/auth/contacts'],
    // CROSS-VENDOR: the Google destination for Copilot's Office 365 Outlook Contacts
    // operations. Confirmed 2026-09-01 against Google's People API reference —
    // people.connections.list / people.get / people.createContact / people.updateContact /
    // contactGroups.list all exist and need nothing beyond this one scope. There is no
    // keep-on-Microsoft equivalent yet (no Graph contacts tools in connector_tools/
    // outlook.py), so agentSurfaceChoice.ts offers only this target for now.
    permissionsHint:
      'Uses the same service account key as your other Google connectors (see the Google Cloud ' +
      'credential group). Authorize its Client ID for domain-wide delegation with THIS scope too ' +
      '— a SEPARATE grant from gmail.modify and calendar, even if this agent also uses those. ' +
      "WHICH account's contacts each agent acts on is set per-agent on the next screen.",
  },

  shared_googlechat: {
    docsUrl: 'https://developers.google.com/workspace/chat/api/reference/rest',
    requiredPermissions: [
      // Required — the connector does not work without these two.
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/chat.spaces',
      // OPTIONAL, deliberately NOT in `scope`: each unlocks one tool, and including an
      // ungranted one in the token request breaks every other tool. See the scope note in
      // googleCatalog.ts and the measurement below.
      'https://www.googleapis.com/auth/chat.memberships.readonly (optional — enables listing space members)',
      'https://www.googleapis.com/auth/chat.spaces.create (optional — enables creating spaces)',
    ],
    // CROSS-VENDOR: the Google destination for Microsoft's Teams connector. Chat is a HARDER
    // target than Gmail, and not because of the API surface:
    //   - Chat is FLAT. A Team containing many Channels has no equivalent; both collapse to
    //     one Space, so "which team is this channel in" stops having an answer.
    //   - Chat has two identity models. A service account can act as a registered CHAT APP
    //     (which must be a member of every space it touches), or impersonate a user through
    //     domain-wide delegation. The tools are written so the same code serves both:
    //     impersonate_email set = act as that user; unset = act as the app.
    //   - Interactive surfaces do not carry over. Posting a card works; a card the user can
    //     click does not — that needs an app receiving events, and a deployed agent is a tool
    //     CALLER, not a hosted app.
    // MEASURED 2026-08-20, not inferred: DWD reads work as the impersonated person, but
    // message CREATION returns 404 "Google Chat app not found" until the Cloud project has a
    // Chat app configured. Reading and writing have different prerequisites, which the hint
    // has to say or a customer grants the scopes and still cannot post.
    permissionsHint:
      'READING needs the service account Client ID authorized for domain-wide delegation with the scopes below, exactly as written — scope strings are matched EXACTLY. POSTING additionally needs a Chat app configured on the Cloud project (Google Cloud Console -> Chat API -> Configuration). Without it every send returns 404 "Google Chat app not found", however many scopes are granted. Note that once configured, the agent posts AS THE APP and everyone in the space sees that, rather than posting as a person.',
    // Chat is the one app that does NOT take the shared credential group: it needs fields of
    // its own, including the write gate below.
    credentials: [
      { key: 'service_account_json', label: 'Service Account JSON key (your own project)', type: 'password',
        placeholder: '{"type":"service_account","project_id":...}',
        hint: 'Google Cloud Console -> IAM & Admin -> Service Accounts -> Create Service Account -> Keys -> Add key (JSON). Paste the whole file. Enable the Google Chat API on that project.' },
      // Which person the Chat tools act as, through domain-wide delegation. Unset = act as
      // the app, which only sees spaces the app was added to.
      { key: 'impersonate_email', label: 'Act as user (email)', type: 'text',
        placeholder: 'person@yourcompany.com',
        hint: 'The Workspace user whose Chat spaces and messages the agent reads.' },
      // THE WRITE GATE. chat.py withholds chat_send_message, chat_reply_to_message,
      // chat_send_card, chat_update_message and chat_create_space unless this reads true,
      // because message creation returns 404 until the Cloud project has a Chat app
      // configured (measured 2026-08-20) and a model handed a send tool that always 404s will
      // retry, apologise, and report the failure as its own.
      //
      // The gate was unreachable: chat.py read `secret("chat_app_configured")` and no field
      // declared it, so it could never be set and the five write tools could never appear.
      // Since Microsoft forbids app-only message POSTs outside import, Google Chat is the
      // ONLY path to a working send — which made this the single field standing between the
      // product and any messaging write at all. Found 2026-08-22.
      { key: 'chat_app_configured', label: 'Chat app configured? (true/false)', type: 'text',
        placeholder: 'false',
        hint: 'Set to "true" only after creating a Chat app in the same Google Cloud project (Google Chat API -> Configuration). Until then message-sending tools are withheld, because Chat answers 404 without one.' },
    ],
    credentialGroup: undefined,
  },
};

/**
 * The Google connectors this project offers.
 *
 * An app in the catalogue with no `scope` is deliberately NOT returned. A connector whose DWD
 * grant is unknown would appear in the UI as supported, ask for nothing, and then fail every
 * call with `unauthorized_client` — worse than not offering it. The scope is the one field
 * Discovery cannot supply (see googleCatalog.ts: deriving it produced `auth/drive` for
 * Sheets, Docs, Slides and Forms, i.e. every file in the customer's Drive to use a
 * spreadsheet), so enabling a new app is: generate the catalog row, then decide its scope.
 */
export function googleConnectors(): ConnectorDef[] {
  return GOOGLE_APPS.filter((a) => a.scope).map((a): ConnectorDef => {
    const o = OVERRIDES[a.id];
    return {
      id: a.id,
      name: o?.name ?? a.name,
      category: a.category,
      icon: a.icon,
      docsUrl: o?.docsUrl ?? a.docsUrl,
      requiredPermissions: o?.requiredPermissions ?? [a.scope],
      permissionsHint: o?.permissionsHint,
      credentials: o?.credentials ?? GOOGLE_POLICY.credentials,
      credentialGroup: o && 'credentials' in o ? o.credentialGroup : GOOGLE_POLICY.credentialGroup,
      baseUrlTemplate: a.baseUrlTemplate,
      authHeaderTemplate: GOOGLE_POLICY.authHeaderTemplate,
      authKind: GOOGLE_POLICY.authKind,
      scope: a.scope,
      impersonation: GOOGLE_POLICY.impersonation,
    };
  });
}

/**
 * Google apps we have catalogue data for but do not offer yet, and why — so the Connectors
 * screen can say "we know about Sheets, it needs a scope decision" instead of silently
 * omitting it.
 */
export function googleAppsAwaitingScope(): string[] {
  return GOOGLE_APPS.filter((a) => !a.scope).map((a) => a.id);
}
