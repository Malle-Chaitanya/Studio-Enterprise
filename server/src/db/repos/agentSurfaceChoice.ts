import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { AgentIR } from '../../types.js';

/**
 * Where does this agent's Microsoft surface point after migration?
 *
 * WHY THIS EXISTS: every other connector is same-vendor, so wiring it needs no decision. Mail
 * is different, and it is NOT a yes/no. A customer moving agents to Gemini has three real
 * positions, and picking any of them for them would be wrong:
 *
 *   KEEP OUTLOOK  The agent moves to Gemini; its mail stays in Microsoft 365. This is the
 *                 common case for a phased migration — nobody wants their mail platform
 *                 decided as a side effect of moving an agent. The migrated agent calls
 *                 Microsoft Graph directly.
 *   USE GMAIL     The agent moves AND its mail moves. Full Workspace migration.
 *   SKIP MAIL     The agent migrates with no mail tools at all.
 *
 * An earlier version of this offered only Gmail-or-nothing, which quietly forced a mail
 * migration on anyone who just wanted the agent moved.
 *
 * `decision` is never set by the system. Absent means UNDECIDED, and undecided wires NO mail
 * tools — the same fail-closed posture as agentConnectorIdentity's 'suggested' vs
 * 'confirmed'. Silence must never read as consent to point an agent at a mailbox.
 *
 * Multi-tenant: every read and write filters by `appUserId`.
 */
export interface AgentSurfaceChoice {
  appUserId: string;
  /** Copilot botid. */
  sourceId: string;
  /** The Microsoft connector this decision is about, e.g. `shared_office365`. */
  sourceConnectorId: string;
  /**
   * Which target was chosen. `skip` means no mail tools at all. Anything else is the
   * connector id of the destination — `shared_outlook` to stay on Microsoft Graph,
   * `shared_gmail` to move to Google.
   */
  decision: 'skip' | string;
  /** The connector wired, absent when the decision is `skip`. */
  targetConnectorId?: string;
  /**
   * Which mailbox this agent reads. Required for BOTH targets — Graph and Gmail each need to
   * be told whose mail, because a deployed agent holds one identity rather than the caller's.
   */
  impersonateEmail?: string;
  /** Who decided, for the audit trail. */
  decidedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLL = 'agentSurfaceChoice';

/** One place an agent's mail can point after migration. */
export interface SurfaceTarget {
  connectorId: string;
  /** Shown on the button. */
  name: string;
  /** What is kept and what is lost. Shown verbatim before the customer chooses. */
  summary: string;
  /** An admin step the customer must complete first, or undefined when there is none. */
  prerequisite?: string;
}

/**
 * Microsoft surface -> the places it can point, in the order they are offered.
 *
 * Staying on Microsoft is listed FIRST and deliberately: it is the lower-risk option and the
 * one that changes least about how the agent behaves. Offering Gmail first would nudge a
 * customer toward a mail migration they may not have asked for.
 */
export const SURFACE_EQUIVALENTS: Record<
  string,
  {
    sourceName: string;
    /**
     * What this surface IS, in the customer's words ('mail', 'Teams messaging'). Used in the
     * report and the log line when no decision was recorded, so a Teams agent is not told
     * it has 'no mail tools'.
     */
    noun: string;
    targets: SurfaceTarget[];
    /**
     * false ONLY for Dataverse. Every other surface here is a personal identity (a mailbox, a
     * calendar, a Teams account) — the deployed agent holds ONE identity, so "whose" is never
     * implied by who is asking, and both the API and the UI require naming it before a
     * decision can be saved. Dataverse -> Cloud SQL is not an identity choice at all: it is
     * "copy this table once" vs "keep calling it live," so requiring an email here would be
     * asking for information the decision has no use for. Absent (the default) means true —
     * every existing surface keeps requiring one without having to say so.
     */
    requiresIdentity?: boolean;
    /**
     * What this surface behaves as when NO decision has been recorded yet. Every other surface
     * leaves this undefined and FAILS CLOSED (wires nothing) — silence must never read as
     * consent to reach into someone's mailbox or team's chat history. Dataverse is different:
     * before this choice existed, an agent's live Dataverse tool already worked with no
     * decision required at all, and failing it closed the same way mail does would regress
     * every customer NOT doing a tenant cutover the day this shipped. Defaulting silence to
     * "keep behaving exactly as before" is what makes this additive rather than breaking.
     */
    defaultDecision?: string;
  }
> = {
  shared_office365: {
    sourceName: 'Outlook',
    noun: 'mail',
    targets: [
      {
        connectorId: 'shared_outlook',
        name: 'Keep Outlook',
        summary:
          'The agent moves to Gemini but its mail stays in Microsoft 365. It reads and sends ' +
          'through Microsoft Graph, so folders stay folders and flags stay flags — nothing ' +
          'about the mail behaviour changes. Choose this for a phased migration, or when the ' +
          'mail platform is not moving at all.',
        prerequisite:
          'Your Entra app registration needs the APPLICATION permissions Mail.ReadWrite and ' +
          'Mail.Send, with admin consent granted. Without them the agent deploys but every ' +
          'mail call is refused.',
      },
      {
        connectorId: 'shared_gmail',
        name: 'Use Gmail',
        summary:
          'The agent reads and sends Google mail instead. Searching, reading, drafting, ' +
          'replying, forwarding and organising all carry over. Outlook folders become Gmail ' +
          'labels (a message can hold several at once), flags become stars and lose their due ' +
          'dates, and MailTips and approval emails do not carry over at all.',
        prerequisite:
          'Your Workspace admin must authorise the service account for gmail.modify in ' +
          'domain-wide delegation. Scope strings are matched exactly.',
      },
    ],
  },
  // Composite key, not a real connector id: Copilot's Office 365 Outlook Calendar
  // operations share the SAME source connector (shared_office365) as mail, but which
  // Google service they should point at is a genuinely separate decision — a customer
  // may keep mail on Microsoft while moving calendar to Google, or the reverse. Real
  // operationIds confirmed live 2026-08-31 against an actual child agent ("Meeting
  // Scheduler Agent"): Create event (V4), Get calendar view of events (V3), Get
  // calendars (V2), Find meeting times (V2) — see CALENDAR_OPERATION_IDS below, which is
  // what `agentUsesSurface` uses to tell a calendar operation apart from a mail one on
  // the same connector id.
  'shared_office365:calendar': {
    sourceName: 'Outlook Calendar',
    noun: 'calendar',
    targets: [
      {
        connectorId: 'shared_outlook',
        name: 'Keep Outlook Calendar',
        summary:
          'The agent moves to Gemini but its calendar stays in Microsoft 365 — it reads and ' +
          'creates events through Microsoft Graph. Only the calendar-view read operation is ' +
          'proven live so far; event creation on this path is new. NOTE: this uses the SAME ' +
          'connector module as "Keep Outlook" mail — if this agent\'s mail was routed to ' +
          'Gmail separately, choosing this brings its Outlook MAIL tools back too, bundled ' +
          'alongside the calendar ones, since today the two are not independently wired.',
        prerequisite:
          'Your Entra app registration needs the APPLICATION permission Calendars.Read (and ' +
          'Calendars.ReadWrite for booking), with admin consent — a SEPARATE grant from the ' +
          'Mail.* permissions, confirmed live: a missing Calendars.Read grant answers ' +
          'ErrorAccessDenied even when Mail.* is fully consented.',
      },
      {
        connectorId: 'shared_googlecalendar',
        name: 'Use Google Calendar',
        summary:
          'The agent reads and books Google Calendar events instead. Checking availability ' +
          'and creating events both carry over. Outlook\'s four-state "Show As" (Free/Busy/' +
          'Tentative/OOF) collapses to Google\'s two-state transparency (busy/free) plus a ' +
          'status field — not a one-to-one translation. Booking always targets the ' +
          'impersonated account\'s own primary calendar; there is no equivalent of targeting ' +
          'an arbitrary other calendar.',
        prerequisite:
          'Your Workspace admin must authorise the service account for the scope ' +
          'https://www.googleapis.com/auth/calendar in domain-wide delegation — a SEPARATE ' +
          'grant from gmail.modify, even if this agent also uses Gmail. Scope strings are ' +
          'matched exactly.',
      },
    ],
  },
  // Composite key, same shape as 'shared_office365:calendar' above: Copilot's Office 365
  // Outlook Contacts operations share the SAME source connector (shared_office365) as
  // mail and calendar, and whether they move to Google is its own independent decision.
  // Real operationIds confirmed 2026-09-01 from the captured swagger
  // (fixtures/shared_office365.ops.json): Create contact (V2), Get contact (V2), Get
  // contact folders (V2), Get contacts (V2), Update contact (V2) — see
  // CONTACTS_OPERATION_IDS below.
  //
  // Only ONE target is offered, deliberately: connector_tools/outlook.py has no contact
  // functions today, so a "Keep Outlook Contacts" option would be selectable with
  // nothing behind it — the exact kind of overclaim this table exists to prevent. If a
  // Graph-side contacts module is ever built, add it here as a second target.
  'shared_office365:contacts': {
    sourceName: 'Outlook Contacts',
    noun: 'contacts',
    targets: [
      {
        connectorId: 'shared_googlecontacts',
        name: 'Use Google Contacts',
        summary:
          'The agent reads and writes the impersonated account\'s Google Contacts instead. ' +
          'Listing, looking up, creating and updating contacts all carry over. Outlook ' +
          'contact folders (a contact lives in exactly one) become Google contact groups ' +
          '(a contact can belong to several, or none) — the same class of gap MoveV2/' +
          'GetMailboxFolders already documents for mail. Contact ids are NOT portable: a ' +
          'migrated agent must look a contact up by name first, never by its old Outlook id.',
        prerequisite:
          'Your Workspace admin must authorise the service account for the scope ' +
          'https://www.googleapis.com/auth/contacts in domain-wide delegation — a SEPARATE ' +
          'grant from gmail.modify and calendar, even if this agent also uses those. Scope ' +
          'strings are matched exactly.',
      },
    ],
  },
  // Microsoft's own "Work IQ" MCP servers (Preview) — a DIFFERENT source connector id
  // from shared_office365, confirmed live 2026-09-02 against the real Meeting
  // Intelligence Agent: Mail (Preview) binds as connectorId shared_a365outlookmailmcp,
  // Calendar (Preview) as shared_a365outlookcalendarmcp, each already its own connector
  // id (unlike shared_office365's one-id-three-capabilities overload), so no composite
  // ":calendar" key is needed here — agentUsesSurface's plain-key path already tells
  // them apart correctly.
  //
  // These carry a DIFFERENT, more specific tool list than shared_office365's mail/
  // calendar operations, declared via AgentToolIR.mcp.tools rather than a swagger
  // operationId — see connectors/boundToolSpec.ts's own comment on why an MCP tool built
  // on a source with no real bindable operation index (this one; Microsoft never exposes
  // a365outlookmailmcp/a365outlookcalendarmcp as a callable Power Platform connector)
  // cannot be expanded the way the Jira-MCP case is. The re-implementation targets below
  // are the only real path — same modules shared_office365's mail/calendar targets use.
  shared_a365outlookmailmcp: {
    sourceName: 'Outlook Mail (Work IQ MCP, Preview)',
    noun: 'mail',
    targets: [
      {
        connectorId: 'shared_outlook',
        name: 'Keep Outlook',
        summary:
          'Same vendor, different Microsoft API (Graph instead of the Work IQ MCP server), ' +
          'so this is the higher-fidelity choice. outlook_search_messages/outlook_get_attachment ' +
          'cover SearchMessages, GetMessage, GetAttachments and DownloadAttachment. ' +
          'SearchMessagesQueryParameters is not a distinct action on either target — it reads ' +
          'as a parameter-schema helper for SearchMessages, not something with its own behavior ' +
          'to reproduce.',
        prerequisite:
          'Your Entra app registration needs the APPLICATION permissions Mail.ReadWrite and ' +
          'Mail.Send, with admin consent granted.',
      },
      {
        connectorId: 'shared_gmail',
        name: 'Use Gmail',
        summary:
          'Cross-vendor: gmail_search_messages and gmail_get_attachment cover SearchMessages, ' +
          'GetMessage, GetAttachments and DownloadAttachment, with the same folder-vs-label ' +
          'divergence already documented for shared_office365 mail. ' +
          'SearchMessagesQueryParameters is not a distinct action on either target (see Keep ' +
          'Outlook\'s summary).',
        prerequisite:
          'Your Workspace admin must authorise the service account for gmail.modify in ' +
          'domain-wide delegation. Scope strings are matched exactly.',
      },
    ],
  },
  shared_a365outlookcalendarmcp: {
    sourceName: 'Outlook Calendar (Work IQ MCP, Preview)',
    noun: 'calendar',
    // Only ONE target, deliberately — same reasoning as shared_office365:contacts above.
    // A "Keep Outlook Calendar" option pointed at shared_outlook would be selectable with
    // no Graph-side calendar module behind it (outlook.py is mail-only), AND it would
    // silently collide with mail's OWN "Keep Outlook" choice (same connectorId, so
    // orchestrator.ts's `already` check skips building anything a second time) — the
    // customer picks "calendar" and gets nothing, or unknowingly gets mail tools they
    // already had. Add a real target here only once a Graph calendar module exists.
    targets: [
      {
        connectorId: 'shared_googlecalendar',
        name: 'Use Google Calendar',
        summary:
          'calendar_list_events covers ListEvents and ListCalendarView (collapsed into one — ' +
          'Graph\'s calendarView expansion of recurring instances vs plain events is a real ' +
          'semantic difference this single tool may not fully replicate). ' +
          'calendar_get_current_datetime covers GetUserDateAndTimeZoneSettings. ' +
          'GetOnlineMeetingTranscripts and GetOnlineMeetingAiInsights are Teams/Copilot meeting-' +
          'AI features with NO Google Calendar equivalent — confirmed 2026-09-02, not built on ' +
          'any target this codebase offers. For an agent whose purpose centers on meeting ' +
          'intelligence, this is likely the loss that matters most — review before relying on ' +
          'this migration.',
        prerequisite:
          'Your Workspace admin must authorise the service account for the scope ' +
          'https://www.googleapis.com/auth/calendar in domain-wide delegation. Scope strings ' +
          'are matched exactly.',
      },
    ],
  },
  shared_teams: {
    sourceName: 'Microsoft Teams',
    noun: 'Teams messaging',
    targets: [
      {
        connectorId: 'shared_teams',
        name: 'Keep Teams (read-only)',
        summary:
          'The agent moves to Gemini and can still READ Teams — channels, chats, messages, ' +
          'replies and membership, with the team-and-channel structure intact. It CANNOT ' +
          'post, reply or send. That is a Microsoft limit, not a setting: app-only access ' +
          'cannot write Teams messages at all, so an agent that used to send messages loses ' +
          'that ability on this path and keeps it only by moving to Google Chat.',
        prerequisite:
          'Your Entra app registration needs the APPLICATION permissions Team.ReadBasic.All, ' +
          'Channel.ReadBasic.All, ChannelMessage.Read.All and Chat.ReadWrite.All, with admin ' +
          'consent. Add Channel.Create only if the agent creates channels. There is no ' +
          'permission to add for sending: ChannelMessage.Send is delegated-only, and the one ' +
          'app-only write route (Teamwork.Migrate.All) is the bulk import API and requires ' +
          'the team to be in migration mode.',
      },
      {
        connectorId: 'shared_googlechat',
        name: 'Use Google Chat',
        summary:
          'The agent posts and reads in Google Chat instead — this is the ONLY path where a ' +
          'migrated agent can still send messages. Messages, replies, direct ' +
          'messages, membership and space creation carry over. What does not: Google Chat is ' +
          'FLAT, so a team containing channels becomes unrelated spaces and "which team is ' +
          'this in" stops having an answer; threading is a per-space setting rather than a ' +
          'per-message choice; Adaptive Cards become display-only cards with no working ' +
          'buttons; and meeting recordings, transcripts and Copilot AI insights do not carry ' +
          'over at all.',
        prerequisite:
          'TWO separate steps, because reading and posting have different requirements ' +
          '(measured, not assumed). READING: your Workspace admin authorises the service ' +
          'account for chat.messages and chat.spaces in domain-wide delegation — scope ' +
          'strings are matched exactly. POSTING: additionally configure a Chat app on the ' +
          'Cloud project (Chat API -> Configuration), or every send fails with 404 "Google ' +
          'Chat app not found" no matter what is granted. Once configured the agent posts AS ' +
          'THE APP, which everyone in the space sees. Without that second step this path ' +
          'reads but cannot write.',
      },
    ],
  },
  // Not an identity choice like the surfaces above — see requiresIdentity's own doc comment.
  // 'cloudsql' below is NOT a real registry connector id; orchestrator.ts special-cases this
  // one surface and never runs it through the generic connector-spec builder every other
  // target here goes through (see orchestrator.ts's Cloud SQL block for why).
  shared_commondataserviceforapps: {
    sourceName: 'Microsoft Dataverse',
    noun: 'data',
    requiresIdentity: false,
    defaultDecision: 'shared_commondataserviceforapps',
    targets: [
      {
        connectorId: 'shared_commondataserviceforapps',
        name: 'Keep Dataverse',
        summary:
          'The agent moves to Gemini but this tool keeps calling Dataverse live, through the ' +
          'Microsoft Dataverse connector credentials configured on the Connectors step — ' +
          'nothing about the tool\'s behavior changes. Choose this for a phased migration, or ' +
          'whenever Dataverse is not being retired.',
        prerequisite:
          'Configure the Microsoft Dataverse connector credentials on the Connectors step, the ' +
          'same as any other Microsoft connector.',
      },
      {
        connectorId: 'cloudsql',
        name: 'Use Cloud SQL',
        summary:
          'This tool\'s backing Dataverse table is copied once into Cloud SQL for PostgreSQL, ' +
          'in your own Google Cloud project, and the deployed agent queries Postgres instead ' +
          'of calling Dataverse live. Choose this ONLY if Dataverse itself will stop existing ' +
          'after this migration — Dataverse\'s own row-level security (who can see which rows) ' +
          'has no equivalent here, so every caller sees the same rows, and the copy is ' +
          'point-in-time as of the migration run, not a live sync.',
        prerequisite:
          'Your Google Cloud project needs the Cloud SQL Admin API enabled, with this ' +
          'migration\'s service account granted the "Cloud SQL Admin" and "Service Usage ' +
          'Consumer" roles.',
      },
    ],
  },
};

export async function getAgentSurfaceChoice(
  appUserId: string,
  sourceId: string,
  sourceConnectorId: string,
): Promise<AgentSurfaceChoice | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB)
      .collection<AgentSurfaceChoice>(COLL)
      .findOne({ appUserId, sourceId, sourceConnectorId });
  } catch (e) {
    logger.warn(`getAgentSurfaceChoice read failed: ${(e as Error).message}`);
    return null;
  }
}

/** Every decision recorded for this customer, for the selection screen. */
export async function listAgentSurfaceChoices(
  appUserId: string,
  sourceIds?: string[],
): Promise<AgentSurfaceChoice[]> {
  if (!isDbConnected()) return [];
  try {
    const filter: Record<string, unknown> = { appUserId };
    if (sourceIds?.length) filter.sourceId = { $in: sourceIds };
    return await getDb(config.CSGE_DB).collection<AgentSurfaceChoice>(COLL).find(filter).toArray();
  } catch (e) {
    logger.warn(`listAgentSurfaceChoices read failed: ${(e as Error).message}`);
    return [];
  }
}

/** Record one decision. Best-effort: a Mongo outage must not stop a migration. */
export async function saveAgentSurfaceChoice(
  choice: Omit<AgentSurfaceChoice, 'createdAt' | 'updatedAt'>,
): Promise<boolean> {
  if (!isDbConnected()) return false;
  try {
    const now = new Date();
    await getDb(config.CSGE_DB)
      .collection<AgentSurfaceChoice>(COLL)
      .updateOne(
        {
          appUserId: choice.appUserId,
          sourceId: choice.sourceId,
          sourceConnectorId: choice.sourceConnectorId,
        },
        { $set: { ...choice, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    return true;
  } catch (e) {
    logger.warn(`saveAgentSurfaceChoice write failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Where should this agent's mail point?
 *
 * Returns null unless a target was explicitly chosen, UNLESS this surface declares a
 * `defaultDecision` (only Dataverse does, today) — then an undecided agent resolves to that
 * default instead of null. Every other surface leaves `defaultDecision` unset and keeps the
 * original fail-closed behavior: undecided and `skip` both wire nothing, because silence must
 * never read as consent to reach a mailbox or a team's chat history. See `defaultDecision`'s
 * own doc comment on `SURFACE_EQUIVALENTS` for why Dataverse is the one exception.
 */
export async function resolveSurfaceTarget(
  appUserId: string,
  sourceId: string,
  sourceConnectorId: string,
): Promise<{ targetConnectorId: string; impersonateEmail?: string } | null> {
  const equivalent = SURFACE_EQUIVALENTS[sourceConnectorId];
  if (!equivalent) return null;
  const choice = await getAgentSurfaceChoice(appUserId, sourceId, sourceConnectorId);
  if (!choice) {
    return equivalent.defaultDecision ? { targetConnectorId: equivalent.defaultDecision } : null;
  }
  if (choice.decision === 'skip') return null;
  const target = choice.targetConnectorId ?? choice.decision;
  // Only ever return a target this surface actually offers. A stored value that is not in
  // the list (an old row, a renamed connector) must read as undecided rather than wire
  // something nobody chose.
  if (!equivalent.targets.some((t) => t.connectorId === target)) return null;
  return { targetConnectorId: target, impersonateEmail: choice.impersonateEmail };
}

/**
 * The exact 4 Office 365 Outlook Calendar operationIds this codebase currently recognizes —
 * measured live 2026-08-31 against a real child agent's actual declared operations (see
 * connectors/equivalence.ts's OTHER_SURFACES rows for the same 4 ids). Used to tell a
 * calendar operation on the shared_office365 connector apart from a mail one, since Copilot
 * gives both the SAME connector id.
 */
export const CALENDAR_OPERATION_IDS = new Set([
  'GetEventsCalendarViewV3',
  'CalendarGetTables_V2',
  'FindMeetingTimes_V2',
  'V4CalendarPostItem',
]);

/**
 * The exact 5 Office 365 Outlook Contacts operationIds this codebase currently
 * recognizes — pulled 2026-09-01 from the captured swagger
 * (fixtures/shared_office365.ops.json), the same source used to confirm the calendar
 * ids above, rather than guessed from the Copilot Studio label text (labels and
 * operationIds do not always correspond 1:1 — see equivalence.ts's `covers` field).
 * Used to tell a contacts operation on the shared_office365 connector apart from a
 * mail or calendar one, since Copilot gives all three the SAME connector id.
 */
export const CONTACTS_OPERATION_IDS = new Set([
  'ContactPostItem_V2',
  'ContactGetItem_V2',
  'ContactGetTablesV2',
  'ContactGetItems_V2',
  'ContactPatchItem_V2',
]);

/**
 * Does this agent actually use the given surface — either a plain connector id (any
 * operation on it that isn't carved out into its own capability) or a composite
 * `"<connectorId>:calendar"` / `"<connectorId>:contacts"` key (only that capability's
 * operations)?
 *
 * Needed because `agentConnectorIds(ir)` (services/connectorToolBuilder.ts) only knows
 * connector ids, not operations — it cannot tell "this agent's shared_office365 usage is
 * mail" from "...is calendar" from "...is contacts", and all three must be offered as
 * INDEPENDENT decisions (a customer may keep mail on Microsoft while moving calendar and
 * contacts to Google, or any other combination).
 */
export function agentUsesSurface(ir: AgentIR, surfaceKey: string): boolean {
  const sepIdx = surfaceKey.indexOf(':');
  const connectorId = sepIdx === -1 ? surfaceKey : surfaceKey.slice(0, sepIdx);
  const capability = sepIdx === -1 ? undefined : surfaceKey.slice(sepIdx + 1);
  const toolsOnConnector = (ir.agentTools ?? []).filter((t) => t.connectorId === connectorId);
  if (capability === 'calendar') {
    return toolsOnConnector.some((t) => t.operationId && CALENDAR_OPERATION_IDS.has(t.operationId));
  }
  if (capability === 'contacts') {
    return toolsOnConnector.some((t) => t.operationId && CONTACTS_OPERATION_IDS.has(t.operationId));
  }
  // Plain key (mail, Teams, or any future non-suffixed surface): any operation that is NOT
  // one of the carved-out calendar/contacts ones counts. For every surface except
  // shared_office365 this is identical to "the connector is used at all" — neither set
  // ever matches a Teams/Jira/etc. operationId.
  return toolsOnConnector.some(
    (t) => !(t.operationId && (CALENDAR_OPERATION_IDS.has(t.operationId) || CONTACTS_OPERATION_IDS.has(t.operationId))),
  );
}
