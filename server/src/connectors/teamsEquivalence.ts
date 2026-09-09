import type { Equivalence } from './equivalence.js';

/**
 * Microsoft Teams -> Google Chat (and, where Chat cannot reach, other Google services).
 *
 * Counted from the Copilot Studio Teams connector's own action menu: **53 operations**,
 * excluding the two MCP entries and the "Run a single action" affordance. That is 2.3x the
 * mail surface, and the headline finding is that only about a quarter of it is messaging.
 * "Teams -> Google Chat" is not one feature; the 53 operations land across Chat, Meet,
 * Calendar, Drive and Tasks, and six have no equivalent anywhere.
 *
 * The individually-listed rows below are the ones with a BUILT tool in
 * scripts/connector_tools/. The rest are bucketed with explicit counts rather than
 * enumerated, because a row per operation would imply a per-operation judgement that has
 * not been made. Bucket counts are stated as counts, never as coverage.
 *
 * THE STRUCTURAL PROBLEM, which no amount of tool-writing fixes: Teams nests Channels inside
 * Teams; Google Chat has one flat `Space`. So "which team is this channel in" has no answer
 * after migration. This is the same class of mismatch as Outlook folders vs Gmail labels,
 * one level worse — labels at least survive as labels.
 *
 * `verified` stays false on every row here until a tool is exercised against a live tenant.
 * The mail table earned its `verified` flags; this one has not yet.
 *
 * THE KEEP-TEAMS PATH IS READ-ONLY — measured 2026-08-20, not assumed. App-only Graph can
 * read channel and chat messages but cannot post either: both return 403 "requires one of
 * Teamwork.Migrate.All" (the bulk import API). `ChannelMessage.Send` is delegated-only and
 * does not exist as an application permission, and this product is pinned to app-only auth
 * for Microsoft. So the two mail-style paths are NOT symmetric here: Google Chat can read and
 * write, keeping Teams can only read. That asymmetry is the single most important thing for a
 * customer to know before choosing, so it leads the option text.
 */
export const TEAMS_MESSAGING: Equivalence[] = [
  {
    surface: 'teams',
    operationId: 'PostMessageToConversation',
    label: 'Post message in a chat or channel',
    target: { service: 'chat', capability: 'spaces.messages.create' },
    fidelity: 'narrowed',
    reason:
      'Posts cleanly. Narrowed because the DESTINATION is not equivalent: a Teams channel ' +
      'belongs to a team, a Chat space belongs to nothing, so an agent that posted to ' +
      '"the Engineering team, General channel" can only be pointed at a single space.',
    tool: 'chat_send_message',
    // MEASURED 2026-08-20: posting returned 404 "Google Chat app not found" as an
    // impersonated user. The tool is built and the read path is proven, but writing needs a
    // Chat app configured on the project. Not marked verified.
    graph: {
      capability:
        'POST .../messages — NOT AVAILABLE app-only. Measured 2026-08-20: 403 "requires one ' +
        'of Teamwork.Migrate.All". ChannelMessage.Send does not exist as an application ' +
        'permission. Keeping Teams means a READ-ONLY agent.',
    },
  },
  {
    surface: 'teams',
    operationId: 'ReplyWithMessageInChannel',
    label: 'Reply with a message in a channel',
    target: { service: 'chat', capability: 'spaces.messages.create + thread.name' },
    fidelity: 'narrowed',
    reason:
      'Threading models differ. Teams attaches a reply to a specific message. Google Chat ' +
      'decides threading PER SPACE — in an unthreaded space the reply posts as a new ' +
      'top-level message instead, so a threaded conversation flattens.',
    tool: 'chat_reply_to_message',
    graph: {
      capability:
        'POST .../replies — NOT AVAILABLE app-only, same 403 as posting. Replying is only ' +
        'possible on the Google Chat path.',
    },
  },
  {
    surface: 'teams',
    operationId: 'GetMessagesInChannel',
    label: 'Get messages in a channel',
    target: { service: 'chat', capability: 'spaces.messages.list' },
    fidelity: 'narrowed',
    reason:
      'Reads cleanly, but Teams keeps channel messages and chat messages in separate ' +
      'operations while Chat has one. The distinction the source agent relied on is gone.',
    verified: true,
    tool: 'chat_list_messages',
    graph: { capability: 'GET /teams/{id}/channels/{id}/messages', tool: 'teams_list_channel_messages' },
  },
  {
    surface: 'teams',
    operationId: 'GetMessagesInChat',
    label: 'Get messages in a chat',
    target: { service: 'chat', capability: 'spaces.messages.list' },
    fidelity: 'narrowed',
    reason: 'Same Chat call as channel messages — see GetMessagesInChannel.',
    verified: true,
    tool: 'chat_list_messages',
    graph: { capability: 'GET /chats/{id}/messages', tool: 'teams_list_chat_messages' },
  },
  {
    surface: 'teams',
    operationId: 'GetMessageDetails',
    label: 'Get message details',
    target: { service: 'chat', capability: 'spaces.messages.get' },
    fidelity: 'exact',
    verified: true,
    tool: 'chat_get_message',
    graph: { capability: 'GET /teams/../messages/{id}, GET /chats/{id}/messages/{id}', tool: 'teams_get_message' },
  },
  {
    surface: 'teams',
    operationId: 'ListRepliesOfChannelMessage',
    label: 'List replies of a channel message',
    target: { service: 'chat', capability: 'spaces.messages.list filtered by thread.name' },
    fidelity: 'narrowed',
    reason:
      'In an unthreaded Chat space every message is its own thread, so this returns the one ' +
      'message rather than a conversation. The tool says so instead of returning an empty list.',
    verified: true,
    tool: 'chat_list_thread_replies',
    graph: { capability: 'GET /teams/{id}/channels/{id}/messages/{id}/replies', tool: 'teams_list_replies' },
  },
  {
    surface: 'teams',
    operationId: 'CreateChat',
    label: 'Create a chat',
    target: { service: 'chat', capability: 'spaces.create / spaces:findDirectMessage' },
    fidelity: 'narrowed',
    reason:
      'A direct message is FOUND rather than created in Chat — the space between two people ' +
      'already exists. Creating a group chat works, but Chat group spaces and Teams group ' +
      'chats differ in membership rules.',
    tool: 'chat_find_direct_message',
    graph: {
      // CORRECTED 2026-08-24: this previously conflated creating the chat OBJECT with
      // sending a message into it — they are different Graph operations governed by
      // different permissions. Chat.Create covers the former; the chatMessage-POST wall
      // below (same root cause as PostMessageToConversation, and a documented platform rule,
      // not a missing grant — Microsoft allows app-only chatMessage POST only for
      // import/migration, Teamwork.Migrate.All) still blocks the latter. NOT yet measured
      // against a live tenant.
      capability:
        'POST /chats — creates the chat object via Chat.Create. This does NOT unblock ' +
        'sending the first message into it: chatMessage POST is still import-only ' +
        '(Teamwork.Migrate.All), so the created chat starts empty and stays that way from ' +
        'this agent — someone has to send the first message from the Teams client.',
      tool: 'teams_create_chat',
    },
  },
  {
    surface: 'teams',
    operationId: 'ListChats',
    // GetChats is the spelling 6 agents declare; same operation, same verdict.
    covers: ['GetChats', 'GetAllChats'],
    label: 'List chats',
    target: { service: 'chat', capability: 'spaces.list' },
    fidelity: 'narrowed',
    reason:
      'Chat returns spaces and direct messages in ONE list with a spaceType, where Teams ' +
      'separates chats from channels. Filtering is on the caller.',
    verified: true,
    tool: 'chat_list_spaces',
    graph: {
      // $expand=members is load-bearing, not a detail: a 1:1 chat has NO topic, so before it
      // every such chat came back as the literal string "(no topic)" and a list of ten was
      // ten identical opaque rows. Re-proven 2026-08-20 with ten chats, each named by its
      // participants.
      capability: 'GET /users/{id}/chats?$expand=members',
      tool: 'teams_list_chats',
      verified: true,
    },
  },
  {
    surface: 'teams',
    operationId: 'ListChannels',
    // GetAllChannelsForTeam is the name 6 of the customer's agents actually declare, and it
    // resolved to nothing until 2026-08-20 — the operation was real, the verdict existed, and
    // only the spelling was missing. Added here rather than as its own row: a second row
    // would grade the same operation twice and the lookup would answer by array order.
    covers: ['ListAllChannels', 'GetAllChannelsForTeam', 'GetChannelsForTeam'],
    label: 'List channels / List all channels / Get all channels for a team',
    target: { service: 'chat', capability: 'spaces.list' },
    fidelity: 'narrowed',
    reason:
      'Channels come back as flat spaces with no team above them. An agent that walked a ' +
      'team and enumerated its channels cannot be reproduced.',
    verified: true,
    tool: 'chat_list_spaces',
    graph: {
      capability: 'GET /teams/{id}/channels',
      tool: 'teams_list_channels',
      // Proven live 2026-08-20 as erik@filefuze.co: three channels for the joined team, with
      // General among them — the assertion that shows the call addressed THAT team rather
      // than succeeding against something else. ($top is rejected on /channels, so the tool
      // slices client-side.)
      verified: true,
    },
  },
  {
    surface: 'teams',
    operationId: 'ListChatOrChannelMembers',
    label: 'List chat or channel members',
    target: { service: 'chat', capability: 'spaces.members.list' },
    fidelity: 'exact',
    tool: 'chat_list_members',
    graph: { capability: 'GET /teams|chats/{id}/members', tool: 'teams_list_members' },
  },
  {
    surface: 'teams',
    operationId: 'CreateChannel',
    label: 'Create a channel',
    target: { service: 'chat', capability: 'spaces.create' },
    fidelity: 'narrowed',
    reason:
      'Creates a space, not a channel inside a team, because Chat has no team to put it in. ' +
      'The grouping the author intended is silently absent — the tool reports this rather ' +
      'than implying success.',
    tool: 'chat_create_space',
    graph: { capability: 'POST /teams/{id}/channels', tool: 'teams_create_channel' },
  },
  {
    surface: 'teams',
    operationId: 'PostCardInChatOrChannel',
    covers: ['ReplyWithAdaptiveCardInChannel', 'UpdateAdaptiveCardInChatOrChannel'],
    label: 'Post card in a chat or channel (and reply/update variants)',
    target: { service: 'chat', capability: 'spaces.messages.create with cardsV2' },
    fidelity: 'narrowed',
    reason:
      'Display only. An Adaptive Card with buttons or a form needs an app that RECEIVES the ' +
      'click, and a deployed agent is a tool caller, not a hosted service. Interactive cards ' +
      'are deliberately not offered — a card with a dead button is worse than no card. ' +
      'Covers 3 source operations (post, reply-with, update).',
    tool: 'chat_send_card',
    graph: { capability: 'POST message with attachments/adaptiveCard' },
  },
  {
    surface: 'teams',
    // 'PostMessageToSelf' is what Copilot Studio ACTUALLY emits — observed on the customer's
    // "Teams Coordinator". My guessed id was PostMessageToMyself, which resolved to nothing.
    operationId: 'PostMessageToSelf',
    covers: ['PostMessageToMyself'],
    label: 'Post a message to myself',
    target: { service: 'chat', capability: 'spaces:findDirectMessage with own user id' },
    fidelity: 'narrowed',
    reason:
      'Google Chat does have a message-yourself space, so this is expected to map — but ' +
      'whether it is addressable through findDirectMessage with the caller as the target is ' +
      'UNVERIFIED. Listed as narrowed rather than exact until probed.',
    tool: 'chat_send_message',
    graph: {
      // Not exercised, and it cannot be: see CreateChat. A note-to-self is still a
      // chatMessage POST, so the import-only restriction applies to it identically — the
      // fact that the sender and recipient are the same person changes nothing.
      capability:
        'POST /chats/{selfChatId}/messages — NOT AVAILABLE app-only, same import-only ' +
        'restriction as every other chatMessage POST.',
    },
  },
  {
    surface: 'teams',
    operationId: 'GetMentionToken',
    label: 'Get an @mention token for a user',
    target: { service: 'chat', capability: '<users/{id}> annotation' },
    fidelity: 'narrowed',
    reason:
      'A different mechanism, not a different format: Teams issues a mention TOKEN to embed, ' +
      'Chat expects a users/{id} annotation resolved from the Directory API — a scope this ' +
      'connector does not request. Not built.',
  },
  {
    surface: 'teams',
    operationId: 'ListJoinedTeams',
    label: 'List joined teams',
    target: null,
    fidelity: 'lost',
    reason:
      'Google Chat has no team object. There is nothing to list, even approximately. On the ' +
      'KEEP-TEAMS path this works unchanged, which is the clearest case in the table for ' +
      'offering that choice at all.',
    // graph.verified, while `fidelity` stays `lost`, and the two are not in conflict:
    // `fidelity` grades the move to Google Chat (no team object exists there, so it really is
    // lost), and `graph` grades the keep-Microsoft path, where the operation works unchanged.
    // Proven live 2026-08-20 as erik@filefuze.co — one joined team returned WITH its name
    // ("non admin team(CFQMSG)"), which is what an agent needs to answer "which teams am I
    // in?" at all.
    graph: {
      capability: 'GET /users/{id}/joinedTeams',
      tool: 'teams_list_joined_teams',
      verified: true,
    },
  },
  {
    surface: 'teams',
    // Split out of the ListJoinedTeams bucket 2026-08-24: bundling three operations behind
    // one `graph` field meant a report reading GetTeam's row off that bucket would have named
    // teams_list_joined_teams as its tool, which is wrong now that teams_get_team exists as
    // its own function — the exact per-operation drift this table exists to prevent.
    operationId: 'GetTeam',
    label: 'Get a team',
    target: null,
    fidelity: 'lost',
    reason:
      'Google Chat has no team object, so there is nothing to fetch by id. On the ' +
      'keep-Microsoft path the operation works unchanged.',
    // Proven live 2026-08-24 (_diag_teams_new_reads_probe.ts) as tenant 807d6772: returned
    // "22nov_public-channel" with visibility=public — the same team ListJoinedTeams sees.
    graph: { capability: 'GET /teams/{team-id}', tool: 'teams_get_team', verified: true },
  },
  {
    surface: 'teams',
    operationId: 'ListAssociatedTeams',
    label: 'List associated teams',
    target: null,
    fidelity: 'lost',
    reason:
      'Google Chat has no team object, so there is nothing to list. On the keep-Microsoft ' +
      'path the operation works, at a different endpoint than the Copilot swagger uses: ' +
      "Graph rejects the swagger's /me/teamwork/associatedTeams app-only (the /me alias needs " +
      'a signed-in user), so the tool calls /users/{id}/teamwork/associatedTeams instead.',
    // Proven live 2026-08-24 (_diag_teams_new_reads_probe.ts) as erik@filefuze.co: 22
    // associated teams returned WITH names — confirming both the permission and the
    // corrected /users/{id} path (the swagger's own /me path was never tried, by design).
    graph: {
      capability: 'GET /users/{id}/teamwork/associatedTeams',
      tool: 'teams_list_associated_teams',
      verified: true,
    },
  },
  {
    surface: 'teams',
    operationId: 'GetChannelDetails',
    label: 'Get details for a specific channel',
    target: null,
    fidelity: 'lost',
    reason:
      "Google Chat has no team object. A channel's identity comes from which team it is in, " +
      'so getting "the channel" by id has no equivalent even though its name and description ' +
      'individually would. On the keep-Microsoft path the operation works unchanged.',
    // Proven live 2026-08-24 (_diag_teams_new_reads_probe.ts): returned "General"
    // membershipType=standard for the channel ListChannels discovered.
    graph: {
      capability: 'GET /teams/{team-id}/channels/{channel-id}',
      tool: 'teams_get_channel',
      verified: true,
    },
  },
  {
    surface: 'teams',
    operationId: 'ArchiveChannel',
    label: 'Archive a channel',
    target: null,
    fidelity: 'lost',
    reason:
      'Chat has no archive. The only comparable action is deleting the space, which destroys ' +
      'its history — mapping a reversible action onto an irreversible one is refused. Note ' +
      'this row was first written as lost WITH a target because update was bundled into it; ' +
      'the honesty test rejected it, which is what that test is for.',
    // NOT yet measured — see teams.py's "ADDITIONAL PERMISSIONS" block (2026-08-24).
    // Channel.ReadWrite.All is a new grant this connector did not previously request.
    graph: {
      capability: 'POST /teams/{team-id}/channels/{channel-id}/archive',
      tool: 'teams_archive_channel',
    },
  },
  {
    surface: 'teams',
    operationId: 'UpdateChannel',
    label: 'Update channel',
    target: { service: 'chat', capability: 'spaces.patch' },
    fidelity: 'narrowed',
    reason:
      'Renaming and re-describing a space maps. What does not is anything about the channel ' +
      'that depends on its team — membership type and team-scoped settings have no ' +
      'equivalent on a standalone space. Not built on the migrate path.',
    // NOT yet measured — see teams.py's "ADDITIONAL PERMISSIONS" block (2026-08-24).
    // Channel.ReadWrite.All is a new grant this connector did not previously request.
    graph: {
      capability: 'PATCH /teams/{team-id}/channels/{channel-id}',
      tool: 'teams_update_channel',
    },
  },
  {
    surface: 'teams',
    operationId: 'CreateATeam',
    label: 'Create a team',
    target: { service: 'chat', capability: 'spaces.create' },
    fidelity: 'narrowed',
    reason:
      'Creates a Chat space, not a Microsoft 365 group with a Team wrapped around it — Chat ' +
      'has no group/team object under a space, so everything that comes from being a group ' +
      '(membership sync, the SharePoint site, Planner, per-team apps) is absent. Not built on ' +
      "the migrate path; chat_create_space covers Create-a-channel's narrower case only.",
    graph: {
      // NOT yet measured — see teams.py's "ADDITIONAL PERMISSIONS" block (2026-08-24).
      // Team.Create is a new grant, heavier than Channel.Create: it provisions a whole group.
      capability:
        'POST /teams — creates a Microsoft 365 group plus Team via Team.Create. ' +
        'Asynchronous (202, no body): the tool reports the request as accepted, not the team ' +
        'as created, because Graph gives no id back to confirm it.',
      tool: 'teams_create_team',
    },
  },
  {
    surface: 'teams',
    operationId: '(16 meeting, call, recording and transcript operations)',
    covers: [
      'CreateTeamsMeeting', 'GetOnlineMeeting',
      'GetCallRecording', 'GetCallRecordingContent', 'GetAllAdHocCallRecordings',
      'GetCallTranscript', 'GetCallTranscriptContent', 'GetAllAdHocCallTranscripts',
      'GetMeetingRecording', 'GetMeetingRecordingContent', 'ListMeetingRecordings',
      'GetMeetingTranscript', 'GetMeetingTranscriptContent', 'ListMeetingTranscripts',
      'ListCallRecordings', 'ListCallTranscripts',
    ],
    label: 'Meetings, call recordings and transcripts',
    target: { service: 'gemini', capability: 'Google Meet API + Calendar API + Drive API' },
    fidelity: 'narrowed',
    reason:
      'NOT Chat at all, and not built. Creating a meeting is Calendar events.insert with ' +
      'conferenceData; recordings and transcripts are Meet conferenceRecords with content in ' +
      'Drive. Reachable in principle, but they pull in three more services AND Meet ' +
      'recording/transcript access is Workspace-EDITION gated, so availability depends on ' +
      'what the customer bought.',
  },
  {
    surface: 'teams',
    operationId: '(9 section operations)',
    covers: [
      'AddItemToSection', 'CreateSection', 'DeleteSection', 'GetSection', 'ListSectionItems',
      'ListSections', 'MoveSectionItem', 'RemoveItemFromSection', 'UpdateSection',
    ],
    label: 'Sections and section items (add, create, delete, get, list, move, remove, update)',
    target: null,
    fidelity: 'lost',
    reason:
      'NOT Teams messaging, and NOT identified. These belong to a surface the Teams connector ' +
      'wraps rather than to Teams chat itself; the closest Google analogues would be Tasks or ' +
      'Keep, neither of which belongs in a chat connector. Recorded as lost rather than ' +
      'guessed at — the connector swagger has to say what they are before anything is mapped.',
  },
  {
    surface: 'teams',
    operationId: '(2 AI insight operations)',
    covers: ['GetAIInsight', 'ListAIInsights'],
    label: 'Get AI insight / List AI insights',
    target: null,
    fidelity: 'lost',
    reason:
      'Copilot-generated meeting insight. Gemini produces comparable notes in the Meet UI but ' +
      'does not expose them as an equivalent API, so there is nothing to call.',
  },
  {
    surface: 'teams',
    operationId: 'RespondInTeamsTaskModule',
    covers: ['PostFeedNotification'],
    label: 'Respond in Teams task module / Post a feed notification (2 operations)',
    target: null,
    fidelity: 'lost',
    reason:
      'Teams UI extension points. A task module needs an app rendering a dialog and handling ' +
      'its submission; the M365 activity feed has no Google counterpart. Chat dialogs exist ' +
      'but require a registered Chat app receiving events, which a deployed agent is not.',
  },
];
