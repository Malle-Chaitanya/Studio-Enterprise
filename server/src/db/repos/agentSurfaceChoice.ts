import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

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
 * Returns null unless a target was explicitly chosen. Undecided and `skip` both wire nothing
 * — the fail-closed default that keeps a mailbox from being reached by silence.
 */
export async function resolveSurfaceTarget(
  appUserId: string,
  sourceId: string,
  sourceConnectorId: string,
): Promise<{ targetConnectorId: string; impersonateEmail?: string } | null> {
  const equivalent = SURFACE_EQUIVALENTS[sourceConnectorId];
  if (!equivalent) return null;
  const choice = await getAgentSurfaceChoice(appUserId, sourceId, sourceConnectorId);
  if (!choice || choice.decision === 'skip') return null;
  const target = choice.targetConnectorId ?? choice.decision;
  // Only ever return a target this surface actually offers. A stored value that is not in
  // the list (an old row, a renamed connector) must read as undecided rather than wire
  // something nobody chose.
  if (!equivalent.targets.some((t) => t.connectorId === target)) return null;
  return { targetConnectorId: target, impersonateEmail: choice.impersonateEmail };
}
