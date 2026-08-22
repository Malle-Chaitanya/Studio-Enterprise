/**
 * Cross-vendor equivalence: Microsoft 365 capability -> Google Workspace capability.
 *
 * This is a DIFFERENT KIND OF TABLE from `VENDOR_BINDINGS` and the two must not be merged.
 * `VENDOR_BINDINGS` is same-vendor: it rewrites a host and keeps the semantics, so a Jira
 * operation becomes the same Jira call. Here the vendor changes, so only the INTENT
 * survives. An Outlook message is not a Gmail message; a folder is not a label. Every row
 * therefore carries a fidelity verdict and, when it is not `exact`, the reason — which is
 * shown to the customer verbatim.
 *
 * One table, three consumers:
 *   1. the customer-facing equivalence matrix and journey doc,
 *   2. the FidelityNotes emitted during migration (honesty rule: never overclaim),
 *   3. which Python tool modules must exist in `scripts/connector_tools/`.
 *
 * Keeping them off one table is how the sales answer and the code drift apart.
 *
 * `verified` is the honesty gate and defaults to false. It means a REAL call was made and
 * the result recorded — not that the mapping looks right. Most rows here are `false`, and
 * that is the accurate state of the world, not an omission to be tidied up.
 */

import { TEAMS_MESSAGING } from './teamsEquivalence.js';

export type Fidelity =
  /** Same capability, no information lost. */
  | 'exact'
  /** The capability survives, but something measurable is lost or constrained. */
  | 'narrowed'
  /** No Google equivalent exists. The behaviour does not migrate. */
  | 'lost';

export type M365Surface = 'outlook' | 'teams' | 'sharepoint' | 'onedrive' | 'copilot';
export type GoogleService = 'gmail' | 'chat' | 'drive' | 'gemini';

export interface Equivalence {
  surface: M365Surface;
  /** Copilot connector operationId, or a capability name for non-operation rows. */
  operationId: string;
  /**
   * Other operationIds this row answers for. A bucketed row ("(16 meeting operations)")
   * describes real operations the agent will actually declare, and without this the lookup
   * misses them and the report says "unmapped" for something we understand precisely.
   * Measured need: "Teams Coordinator" declares GetTeam, which lives in the ListJoinedTeams
   * row and resolved to nothing.
   */
  covers?: string[];
  /** What Copilot showed the author for this operation. */
  label: string;
  target: { service: GoogleService; capability: string } | null;
  fidelity: Fidelity;
  /**
   * Why it is narrowed or lost. REQUIRED unless `exact` — a bare "narrowed" tells the
   * customer nothing and is exactly the kind of soft claim the honesty rule exists to stop.
   */
  reason?: string;
  /** The tool a migrated agent actually gets on the GOOGLE path, when one exists today. */
  tool?: string;
  /**
   * The same Copilot operation on the KEEP-MICROSOFT path: the Graph call and the tool that
   * makes it, for an agent that migrates to Gemini while its mail stays in Microsoft 365.
   *
   * Recorded per operation because this is the other half of "map the API correctly", and
   * because its fidelity is different: nothing is translated on this path, so an operation
   * that is `narrowed` against Gmail is usually exact against Graph. A row with a `graph`
   * entry and a narrowed `fidelity` is NOT contradictory — `fidelity` grades the Google
   * mapping, which is the one that loses information.
   */
  graph?: { capability: string; tool?: string; verified?: boolean };
  /** True only when a real call was made and its result recorded. Defaults false. */
  verified?: boolean;
}

/**
 * Outlook mail.
 *
 * Measured from the captured swagger (`fixtures/shared_office365.ops.json`, 2026-08-19):
 * 143 operations total, of which 89 are deprecated and 34 are event triggers, leaving **49
 * live operations**. The headline "143 operations" overstates the real surface by ~3x.
 *
 * CORRECTION 2026-08-19: an earlier pass claimed "19 of them mail". That number came from
 * filtering operationIds on /mail|message|email/, which silently dropped every mail
 * operation whose NAME lacks those words — MarkAsRead_V3, AssignCategory,
 * GetOutlookCategoryNames, GetAttachment_V2, SetAutomaticRepliesSetting_V2. The user's
 * Copilot Studio "Add a tool" menu surfaced them. The undercount was an artifact of the
 * filter, not a property of the connector: keyword matching on identifiers is not a
 * measurement, and the live UI is the better source of truth for what an author can pick.
 */
export const OUTLOOK_MAIL: Equivalence[] = [
  {
    surface: 'outlook',
    operationId: 'GetEmailsV3',
    label: 'Get emails (V3)',
    target: { service: 'gmail', capability: 'users.messages.list + metadata hydration' },
    fidelity: 'narrowed',
    reason:
      'Outlook filters by folder, importance and flag state. Gmail filters by search query ' +
      'and labels. Common intents (unread, from a sender, recent) map cleanly; a filter that ' +
      'depends on Outlook folder structure does not.',
    tool: 'gmail_search_messages',
    verified: true,
    graph: { capability: 'GET /users/{id}/messages', tool: 'outlook_search_messages', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'GetEmailV2',
    label: 'Get email (V2)',
    target: { service: 'gmail', capability: 'users.messages.get' },
    fidelity: 'exact',
    tool: 'gmail_read_message',
    verified: true,
    graph: { capability: 'GET /users/{id}/messages/{msgId}', tool: 'outlook_read_message', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'ExportEmail_V2',
    label: 'Export email (V2)',
    target: { service: 'gmail', capability: 'users.messages.get?format=raw' },
    fidelity: 'exact',
    graph: { capability: 'GET /users/{id}/messages/{msgId}/$value' },
  },
  {
    surface: 'outlook',
    operationId: 'DraftEmail',
    label: 'Draft an email message',
    target: { service: 'gmail', capability: 'users.drafts.create' },
    fidelity: 'exact',
    tool: 'gmail_create_draft',
    verified: true,
    graph: { capability: 'POST /users/{id}/messages', tool: 'outlook_create_draft', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'UpdateDraftEmail',
    label: 'Update an email draft',
    target: { service: 'gmail', capability: 'users.drafts.update' },
    fidelity: 'exact',
    tool: 'gmail_update_draft',
    verified: true,
    graph: { capability: 'PATCH /users/{id}/messages/{msgId}' },
  },
  {
    surface: 'outlook',
    operationId: 'SendDraftEmail',
    label: 'Send a draft message',
    target: { service: 'gmail', capability: 'users.drafts.send' },
    fidelity: 'exact',
    tool: 'gmail_send_draft',
    verified: true,
    graph: { capability: 'POST /users/{id}/messages/{msgId}/send', tool: 'outlook_send_draft', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'SendEmailV2',
    label: 'Send an email (V2)',
    target: { service: 'gmail', capability: 'users.messages.send' },
    fidelity: 'narrowed',
    reason:
      'Outlook takes structured fields (to, subject, body, importance). Gmail takes a raw ' +
      'RFC-2822 MIME message the caller must build. Importance has no Gmail equivalent and ' +
      'is dropped.',
    tool: 'gmail_send_message',
    verified: true,
    graph: { capability: 'POST /users/{id}/sendMail', tool: 'outlook_send_message', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'ReplyToV3',
    label: 'Reply to email (V3)',
    target: { service: 'gmail', capability: 'users.messages.send + threadId + In-Reply-To' },
    fidelity: 'narrowed',
    reason:
      'Outlook replies to a message id. Gmail threading is header-based: the reply must ' +
      'carry threadId plus In-Reply-To/References or it starts a new conversation.',
    tool: 'gmail_reply_to_message',
    verified: true,
    graph: { capability: 'POST /users/{id}/messages/{msgId}/reply', tool: 'outlook_reply_to_message', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'ForwardEmail_V2',
    label: 'Forward an email (V2)',
    target: { service: 'gmail', capability: 'users.messages.send with quoted body' },
    fidelity: 'narrowed',
    reason:
      'Gmail has no forward primitive. The original must be re-composed into a new message, ' +
      'so forwarded attachments have to be re-uploaded rather than referenced.',
    tool: 'gmail_forward_message',
    verified: true,
    graph: { capability: 'POST /users/{id}/messages/{msgId}/forward', tool: 'outlook_forward_message', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'DeleteEmail_V2',
    label: 'Delete email (V2)',
    target: { service: 'gmail', capability: 'users.messages.trash' },
    fidelity: 'narrowed',
    reason:
      'Mapped to trash, not permanent delete. Deliberate: trash is recoverable and an agent ' +
      'destroying mail irreversibly is a bigger risk than the fidelity gap.',
    tool: 'gmail_trash_message',
    verified: true,
    graph: { capability: 'POST /users/{id}/messages/{msgId}/move -> deleteditems', tool: 'outlook_delete_message', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'MoveV2',
    label: 'Move email (V2)',
    target: { service: 'gmail', capability: 'users.messages.modify (labels)' },
    fidelity: 'narrowed',
    reason:
      'The deepest model mismatch. An Outlook message lives in exactly ONE folder; a Gmail ' +
      'message carries MANY labels. Move becomes add-label + remove-label, so "which folder ' +
      'is this in" has no single answer after migration.',
    tool: 'gmail_modify_labels',
    verified: true,
    graph: { capability: 'POST /users/{id}/messages/{msgId}/move', tool: 'outlook_move_message', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'Flag_V2',
    label: 'Flag email (V2)',
    target: { service: 'gmail', capability: 'users.messages.modify (STARRED)' },
    fidelity: 'narrowed',
    reason:
      'An Outlook flag carries a state and a due date. A Gmail star is a boolean. Due dates ' +
      'and flag states are dropped, not translated.',
    tool: 'gmail_star_message',
    verified: true,
    graph: { capability: 'PATCH message.flag', tool: 'outlook_flag_message', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'AssignCategoryBulk',
    label: 'Assign a category to multiple emails',
    target: { service: 'gmail', capability: 'users.messages.batchModify (labels)' },
    fidelity: 'narrowed',
    reason: 'Outlook category colours have no Gmail equivalent; only the name survives.',
    tool: 'gmail_modify_labels',
    verified: true,
    graph: { capability: 'PATCH message.categories', tool: 'outlook_set_categories', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'GetMailTips_V2',
    label: 'Get mail tips for a mailbox (V2)',
    target: null,
    fidelity: 'lost',
    reason:
      'MailTips report out-of-office status, mailbox-full and external-recipient warnings ' +
      'before sending. Gmail exposes no equivalent API.',
    graph: { capability: 'POST /users/{id}/getMailTips' },
  },
  {
    surface: 'outlook',
    operationId: 'SendApprovalMail',
    label: 'Send approval email',
    target: null,
    fidelity: 'lost',
    reason:
      'Not an email feature. A Power Automate construct: actionable buttons wired back to a ' +
      'flow that waits on the response. No vendor has an equivalent, Google included.',
  },
  {
    surface: 'outlook',
    operationId: 'SendMailWithOptions',
    label: 'Send email with options',
    target: null,
    fidelity: 'lost',
    reason: 'Same as SendApprovalMail — an actionable-message construct tied to Power Automate.',
  },
  {
    surface: 'outlook',
    operationId: 'SharedMailboxSendEmailV2',
    label: 'Send an email from a shared mailbox (V2)',
    target: { service: 'gmail', capability: 'delegated send / separate DWD subject' },
    fidelity: 'narrowed',
    reason:
      'Google delegation is per-mailbox and must be granted separately. The migrated agent ' +
      'needs its own impersonation subject for each shared mailbox.',
    graph: { capability: 'POST /users/{sharedBox}/sendMail' },
  },
  {
    surface: 'outlook',
    operationId: 'GetMailboxFolders',
    label: 'Folders',
    target: { service: 'gmail', capability: 'users.labels.list' },
    fidelity: 'narrowed',
    reason: 'Folders are exclusive; labels are not. See MoveV2.',
    tool: 'gmail_list_labels',
    verified: true,
    graph: { capability: 'GET /users/{id}/mailFolders', tool: 'outlook_list_folders', verified: true },
  },
  // Added 2026-08-19 after the Copilot Studio "Add a tool" menu showed operations the first
  // pass missed. The original sweep filtered operationIds on mail|message|email, which these
  // do not contain — an undercount produced by the filter, not by the connector.
  {
    surface: 'outlook',
    operationId: 'MarkAsRead_V3',
    label: 'Mark as read or unread (V3)',
    target: { service: 'gmail', capability: 'users.messages.modify (UNREAD label)' },
    fidelity: 'exact',
    tool: 'gmail_mark_read',
    verified: true,
    graph: { capability: 'PATCH message.isRead', tool: 'outlook_mark_read', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'AssignCategory',
    label: 'Assigns an Outlook category',
    target: { service: 'gmail', capability: 'users.messages.modify (label)' },
    fidelity: 'narrowed',
    reason: 'Outlook category colours have no Gmail equivalent; only the name survives.',
    tool: 'gmail_modify_labels',
    verified: true,
    graph: { capability: 'PATCH message.categories', tool: 'outlook_set_categories', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'GetOutlookCategoryNames',
    label: 'Get Outlook category names',
    target: { service: 'gmail', capability: 'users.labels.list' },
    fidelity: 'narrowed',
    reason:
      'Category names map to label names, but Gmail returns system labels (INBOX, SENT, ' +
      'CATEGORY_*) in the same list, so the result is broader than the Outlook original.',
    tool: 'gmail_list_labels',
    verified: true,
    graph: { capability: 'GET /users/{id}/outlook/masterCategories' },
  },
  {
    surface: 'outlook',
    operationId: 'GetAttachment_V2',
    label: 'Get Attachment (V2)',
    target: { service: 'gmail', capability: 'users.messages.attachments.get' },
    fidelity: 'narrowed',
    reason:
      'Text attachments (txt, csv, json, xml) are read in full. Binary formats (PDF, Word, ' +
      'Excel) are reported by name and size but NOT decoded, and the tool says so rather ' +
      'than letting the model guess at their contents.',
    tool: 'gmail_get_attachment',
    verified: true,
    graph: { capability: 'GET /users/{id}/messages/{msgId}/attachments', tool: 'outlook_get_attachment', verified: true },
  },
  {
    surface: 'outlook',
    operationId: 'SetAutomaticRepliesSetting_V2',
    label: 'Set up automatic replies (V2)',
    target: { service: 'gemini', capability: 'Gmail settings.updateVacation' },
    fidelity: 'narrowed',
    reason:
      'Gmail has a vacation responder, but it lives in the Settings API under a separate ' +
      'scope (gmail.settings.basic) that the current delegation grant does not include.',
    graph: { capability: 'PATCH /users/{id}/mailboxSettings (automaticRepliesSetting)' },
  },
];

/**
 * MCP servers — a tool class the connector-operation model does not describe.
 *
 * Copilot Studio's "Add a tool" menu now offers MCP SERVERS ("Mail MCP", "Calendar MCP")
 * alongside individual connector actions, and the swagger carries them as operations:
 * `mcp_EmailsManagement`, `mcp_ContactsManagement`, `mcp_MeetingManagement` (the first two
 * already marked deprecated, so the naming is in flux).
 *
 * This matters for sizing. An agent wired to "Mail MCP" is not five connector actions to
 * map — it is ONE binding to a Microsoft-hosted server that exposes its own tool list at
 * runtime. We cannot enumerate what it exposes from the swagger, so we cannot state a
 * per-operation fidelity for it the way we can for connector actions.
 *
 * Google ADK does support MCP toolsets, so the SHAPE is migratable in principle. What is not
 * migratable is Microsoft's hosted server itself: it authenticates against M365 and speaks to
 * Outlook. The honest target is our own Gmail tools, which is a re-implementation rather
 * than a re-binding.
 */
export const MCP_SERVERS: Equivalence[] = [
  {
    surface: 'outlook',
    operationId: 'mcp_EmailsManagement',
    label: 'Mail MCP (Email Management MCP Server)',
    target: { service: 'gmail', capability: 'gmail.py tools (re-implementation)' },
    fidelity: 'narrowed',
    reason:
      'An MCP server is a binding to a Microsoft-hosted endpoint, not a list of operations. ' +
      'Its exposed tools cannot be enumerated from the connector definition, so per-operation ' +
      'fidelity cannot be stated in advance — the agent must be inspected. The server itself ' +
      'does not migrate: it authenticates against M365 and talks to Outlook. Migrated agents ' +
      'get our Gmail tools instead, which covers reading and searching but is a ' +
      're-implementation, not a re-binding.',
  },
  {
    surface: 'outlook',
    operationId: 'mcp_MeetingManagement',
    label: 'Calendar MCP (Meeting Management MCP Server)',
    target: null,
    fidelity: 'lost',
    reason:
      'Same server-binding problem as Mail MCP, and there is no calendar equivalent built at ' +
      'all — Google Calendar tools do not exist in this product yet.',
  },
  {
    surface: 'outlook',
    operationId: 'mcp_ContactsManagement',
    label: 'Contact Management MCP Server',
    target: null,
    fidelity: 'lost',
    reason: 'No Google Contacts tools exist in this product yet.',
  },
];

/**
 * Event triggers.
 *
 * 34 of the 143 Outlook operations are triggers (`OnNewEmail`, `OnFlaggedEmail`, webhook
 * subscriptions). They are recorded as ONE row because they share one cause and one verdict.
 *
 * This loss is NOT a Google gap. A migrated agent is request/response: it answers when
 * asked. Nothing on the destination side changes that, so these would be lost migrating
 * Copilot to any target whatsoever. Saying so plainly is more useful to a customer than
 * listing 34 rows that all say the same thing.
 */
export const OUTLOOK_TRIGGERS: Equivalence[] = [
  {
    surface: 'outlook',
    operationId: '(34 trigger operations)',
    label: 'When a new email arrives / is flagged / mentions me',
    target: null,
    fidelity: 'lost',
    reason:
      'Event triggers start a FLOW when something happens. A migrated agent is ' +
      'request/response and has no event loop, so no trigger migrates. This is a ' +
      'Copilot-flow vs agent gap, not a Microsoft vs Google gap — it would be lost ' +
      'migrating to any agent platform. Phase 1 scope is agents only; flows come later.',
  },
];

/** Surfaces beyond mail. Deliberately coarse: none has been measured or built yet. */
export const OTHER_SURFACES: Equivalence[] = [
  {
    surface: 'outlook',
    // The ONE calendar operation a real agent declares, pulled out of the bucket below.
    // Measured on staged agents 2026-08-20; while it sat inside "(35 calendar operations)"
    // the lookup resolved it to nothing, because no agent declares a bucket's name — so the
    // report said "unmapped" for an operation the table had an opinion about.
    operationId: 'GetEventsCalendarViewV3',
    covers: ['GetEventsCalendarView', 'GetEventsV3', 'GetEvents'],
    label: 'Get calendar events in a date range',
    target: { service: 'gemini', capability: 'Google Calendar API events.list' },
    fidelity: 'narrowed',
    reason:
      'NOT BUILT on the Google path: there is no calendar tool in connector_tools/gmail.py ' +
      'and the delegation scope this connector requests is gmail.readonly, so a migrated ' +
      'agent whose mail moved to Google has no calendar access at all. On the KEEP-MICROSOFT ' +
      'path the operation is reproduced exactly by outlook_list_calendar_events (a Graph ' +
      'calendarView, which expands recurring series into occurrences — plain /events would ' +
      'return the series master once and undercount a weekly meeting). That tool is written ' +
      'and PROVEN live on 2026-08-21, once Calendars.Read (application) was consented — a ' +
      'separate grant from the Mail.* ones, which is why it answered ErrorAccessDenied the ' +
      'day before. Ten real events came back for a mailbox that has them, including expanded ' +
      'occurrences of a recurring series.',
    graph: {
      capability: 'GET /users/{id}/calendarView?startDateTime=&endDateTime=',
      tool: 'outlook_list_calendar_events',
      // Now true, and it took TWO measurements to earn — which is the point of the flag.
      // 2026-08-20: ErrorAccessDenied, the grant was missing. 2026-08-21 after the grant: the
      // call was permitted but the default mailbox (alex@filefuze.co) had no events anywhere
      // in 2026, so all it proved was that nothing was refused. A permitted call over an
      // empty calendar is NOT evidence the tool can report a meeting. Re-run against
      // erik@filefuze.co: 10 events, with `recurring` set on expanded occurrences — which is
      // also what proves the tool uses calendarView rather than /events, since plain /events
      // returns the series master once and undercounts a weekly meeting.
      verified: true,
    },
  },
  {
    surface: 'outlook',
    // 34, not 35: GetEventsCalendarViewV3 now has its own row above. The count is decremented
    // rather than left alone, because the whole value of a bucket row is that its number is
    // the honest size of the unexamined remainder.
    operationId: '(34 remaining calendar operations)',
    label: 'Calendar — rooms, availability, invitations, recurrence editing',
    target: { service: 'gemini', capability: 'Google Calendar API' },
    fidelity: 'narrowed',
    reason:
      'Not yet mapped or built, and not referenced by any staged agent. Counted from the same ' +
      'swagger: 34 further calendar, 15 contacts and 6 room operations remain unexamined.',
  },
  {
    surface: 'sharepoint',
    operationId: 'GetAllTables',
    covers: ['GetAllLists', 'GetTables'],
    label: 'Get all lists and libraries',
    target: { service: 'drive', capability: 'Graph /sites/{id}/lists (source-side read)' },
    fidelity: 'narrowed',
    reason:
      'Recreated as sharepoint_list_lists, fixed to the connected site. The source ' +
      'operation could target any site the signed-in user could reach. Proven live ' +
      '2026-08-20: nine lists returned WITH their names (wte, Shared Documents, ' +
      'CLOUDFUZE TEST, ...), which is what makes the answer usable rather than merely ' +
      'successful.',
    tool: 'sharepoint_list_lists',
    verified: true,
  },
  {
    surface: 'sharepoint',
    // The two tools every SharePoint knowledge source depends on. They had no row at all,
    // so the table said nothing about the capability the whole surface rests on.
    operationId: 'ListFolderContents',
    covers: ['GetFolderContents', 'ListFiles', 'GetFileContent'],
    label: 'List a folder and read a document',
    target: { service: 'drive', capability: 'Graph /sites/{id}/drive (source-side read)' },
    fidelity: 'narrowed',
    reason:
      'Served live by sharepoint_list_files and sharepoint_read_file, SCOPED to the folder ' +
      'the source agent named — not the tenant. That scoping is the point: the app ' +
      'credential carries Sites.Read.All and can read every site in the tenant, so an ' +
      'unscoped tool would give the migrated agent reach its Copilot original never had. ' +
      'A source that named a single FILE is indexed instead of scoped, because folder tools ' +
      'given a file path have nothing to list. Proven live 2026-08-20: three items listed ' +
      'and a 12,547-character document read back.',
    tool: 'sharepoint_read_file',
    verified: true,
  },
  {
    surface: 'onedrive',
    // The surface had ZERO rows, so even with the id mapping fixed every OneDrive operation
    // resolved to undefined. A connector in Tier 1 with no verdict anywhere is the exact
    // silence this table exists to remove.
    operationId: 'ListFolderContents',
    covers: ['GetFolderContents', 'ListFiles', 'GetFileContent', 'GetFileMetadata'],
    label: 'List a OneDrive folder and read a file',
    target: { service: 'drive', capability: 'Graph /drives/{id} (source-side read)' },
    fidelity: 'narrowed',
    reason:
      'Served by the same connector_tools/sharepoint.py tools as SharePoint — OneDrive for ' +
      'Business is a SharePoint drive, and the deployer maps both kinds onto that module. ' +
      'Scoped to the folder the source agent named, not the tenant. UNPROVEN for OneDrive ' +
      'specifically: the SharePoint path was exercised live on 2026-08-20, but a OneDrive ' +
      "scope is a personal drive URL (tenant-my.sharepoint.com/personal/...) and that URL " +
      'shape has never been resolved by the tools. No staged agent references this connector, ' +
      'so there is nothing to test against yet — which is a reason to say so, not a reason to ' +
      'assume it works.',
    tool: 'sharepoint_read_file',
    // Deliberately not verified. The tools are shared with a surface that IS proven, and that
    // is precisely the argument that would make a false claim here feel reasonable.
  },
  {
    surface: 'copilot',
    operationId: 'InvokeAIBuilderModelAction',
    label: 'AI Builder model call',
    target: null,
    fidelity: 'lost',
    reason:
      'A trained AI Builder model is customer IP hosted by Microsoft. It cannot be exported ' +
      'or re-hosted, so the call does not migrate. The agent around it does.',
  },
];

export const EQUIVALENCES: Equivalence[] = [
  ...OUTLOOK_MAIL,
  ...OUTLOOK_TRIGGERS,
  ...MCP_SERVERS,
  ...OTHER_SURFACES,
  ...TEAMS_MESSAGING,
];

export interface FidelitySummary {
  exact: number;
  narrowed: number;
  lost: number;
  /**
   * Rows a tool actually exists for. NOT the same as mapped, and the gap is the whole point:
   * on 2026-08-19 the mail surface was 20 mapped, 4 built, 3 proven. A doc that quoted only
   * "20 of 23 migrate" read as "87% works" when what worked was three operations. Mapped
   * means we know the destination; built means there is code; verified means someone made
   * the call. Report all three or none.
   */
  built: number;
  verified: number;
  total: number;
}

/** Count by verdict. Used by the report and the customer matrix. */
export function summarise(rows: Equivalence[] = EQUIVALENCES): FidelitySummary {
  return {
    exact: rows.filter((r) => r.fidelity === 'exact').length,
    narrowed: rows.filter((r) => r.fidelity === 'narrowed').length,
    lost: rows.filter((r) => r.fidelity === 'lost').length,
    built: rows.filter((r) => Boolean(r.tool)).length,
    verified: rows.filter((r) => r.verified === true).length,
    total: rows.length,
  };
}

/** Look up one operation. Returns undefined rather than guessing — an unknown operation
 *  must read as unknown, never as a silent `exact`. */
/**
 * Which M365 surface does a Copilot connector id belong to?
 *
 * Added because a caller hardcoded `findEquivalence('outlook', op)` for a TEAMS agent and
 * every one of its four operations reported "not in the equivalence table" — with the
 * outlook branch's reason text attached, which read as a confident wrong answer rather than
 * a lookup miss. One mapping, used everywhere, instead of a literal at each call site.
 */
export function surfaceForConnector(connectorId: string): M365Surface | null {
  switch (connectorId) {
    case 'shared_office365':
    case 'shared_outlook':
      return 'outlook';
    case 'shared_teams':
    case 'shared_googlechat':
      return 'teams';
    case 'shared_sharepointonline':
      return 'sharepoint';
    // 'shared_onedrive' is the id the REGISTRY defines and an agent declares.
    // 'shared_onedriveforbusiness' was a guess from the product name — it matches nothing, so
    // this branch was dead and every OneDrive agent's operations resolved to null, i.e. were
    // reported UNJUDGED. Same class of bug as the HubSpot ids (ledger 1.10): registry ids
    // guessed from product names, corrected only once measured. The old spelling is kept so
    // any row already persisted under it still resolves.
    case 'shared_onedrive':
    case 'shared_onedriveforbusiness':
      return 'onedrive';
    default:
      return null;
  }
}

export function findEquivalence(
  surface: M365Surface,
  operationId: string,
): Equivalence | undefined {
  return EQUIVALENCES.find(
    (e) =>
      e.surface === surface &&
      (e.operationId === operationId || (e.covers ?? []).includes(operationId)),
  );
}

/**
 * The customer-facing sentence for one operation. Used verbatim in the report, so it must
 * never claim more than the row does.
 */
export function describeEquivalence(e: Equivalence): string {
  if (e.fidelity === 'lost') return `${e.label}: does not migrate. ${e.reason ?? ''}`.trim();
  const target = e.target ? `${e.target.service} (${e.target.capability})` : 'no target';
  const proven = e.verified ? ' Proven live.' : ' Not yet verified against a live system.';
  if (e.fidelity === 'exact') return `${e.label}: migrates to ${target}.${proven}`;
  return `${e.label}: migrates to ${target}, with limits. ${e.reason ?? ''}${proven}`;
}
