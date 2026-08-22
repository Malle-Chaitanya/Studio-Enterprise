import { describe, it, expect } from 'vitest';
import { TEAMS_MESSAGING } from './teamsEquivalence.js';
import { SURFACE_EQUIVALENTS } from '../db/repos/agentSurfaceChoice.js';
import { REGISTRY_BY_ID } from './registry.js';
import { findEquivalence, surfaceForConnector } from './equivalence.js';

/**
 * The mail table's value came from what it REFUSED to claim. These lock the same discipline
 * on Teams before anything is proven, because that is when the temptation to round up is
 * highest: the tools are written, they look right, and nothing has been run yet.
 *
 * The archive/update row already earned its keep — it was first written as `lost` WITH a
 * target because two operations were bundled together, and the honesty test in
 * equivalence.test.ts rejected it.
 */
describe('Teams equivalence honesty', () => {
  it('only the operations actually run live are marked verified', () => {
    // An explicit allow-list, not a blanket rule, so adding a `verified: true` anywhere else
    // fails here and has to be justified with evidence. Every entry below was exercised on
    // 2026-08-20 and returned REAL DATA — not merely a 200.
    const PROVEN_CHAT = new Set([
      'ListChats', 'ListChannels', 'GetMessagesInChannel', 'GetMessagesInChat',
      'GetMessageDetails', 'ListRepliesOfChannelMessage',
    ]);
    // Graph, re-measured 2026-08-20 as erik@filefuze.co (_test_teams_all_tools.ts, 9
    // assertions). The earlier note here said joinedTeams RAN but returned an empty list
    // because that user was in no teams, and that a mechanism working on an empty result is
    // not a proven capability — correct, and now superseded: this user is in a real team, so
    // joinedTeams returned it WITH its name and /channels returned three channels including
    // General. That last assertion is what distinguishes "the call worked" from "the call
    // addressed the team we asked about".
    const PROVEN_GRAPH = new Set(['ListChats', 'ListChannels', 'ListJoinedTeams']);
    for (const r of TEAMS_MESSAGING) {
      expect(Boolean(r.verified), `${r.operationId} verified flag`).toBe(PROVEN_CHAT.has(r.operationId));
      expect(Boolean(r.graph?.verified), `${r.operationId} graph verified flag`).toBe(
        PROVEN_GRAPH.has(r.operationId),
      );
    }
  });

  it('no WRITE operation is marked verified on either path', () => {
    // Chat writes need a Chat app (404 until configured); Teams writes are impossible
    // app-only. Neither has been proven, and both are the flags most tempting to flip.
    for (const op of ['PostMessageToConversation', 'ReplyWithMessageInChannel',
                      'PostCardInChatOrChannel', 'PostMessageToSelf', 'CreateChannel']) {
      const r = TEAMS_MESSAGING.find((x) => x.operationId === op);
      expect(Boolean(r?.verified), `${op} write claims verified`).toBe(false);
      expect(Boolean(r?.graph?.verified), `${op} write claims Graph verified`).toBe(false);
    }
  });

  it('every non-exact row explains itself in specifics', () => {
    for (const r of TEAMS_MESSAGING) {
      if (r.fidelity === 'exact') continue;
      expect(r.reason, `${r.operationId} has no reason`).toBeTruthy();
      expect(r.reason!.length, `${r.operationId} reason is too vague to act on`).toBeGreaterThan(40);
    }
  });

  it('a lost row never names a target', () => {
    for (const r of TEAMS_MESSAGING.filter((x) => x.fidelity === 'lost')) {
      expect(r.target, `${r.operationId} is lost but names a target`).toBeNull();
    }
  });

  it('a row claiming a tool names one that exists in the built tool sets', () => {
    // Guards the drift that matters: a table row promising `chat_send_thing` when no such
    // function was written reads as coverage in the report and fails only in a conversation.
    const chatTools = new Set([
      'chat_list_spaces', 'chat_find_direct_message', 'chat_list_messages', 'chat_get_message',
      'chat_list_thread_replies', 'chat_list_members', 'chat_send_message',
      'chat_reply_to_message', 'chat_send_card', 'chat_update_message', 'chat_create_space',
    ]);
    const teamsTools = new Set([
      'teams_list_joined_teams', 'teams_list_channels', 'teams_list_chats', 'teams_list_members',
      'teams_list_channel_messages', 'teams_list_chat_messages', 'teams_get_message',
      'teams_list_replies', 'teams_create_channel',
    ]);
    for (const r of TEAMS_MESSAGING) {
      if (r.tool) expect(chatTools, `${r.operationId} names unknown Chat tool ${r.tool}`).toContain(r.tool);
      if (r.graph?.tool) {
        expect(teamsTools, `${r.operationId} names unknown Teams tool ${r.graph.tool}`).toContain(r.graph.tool);
      }
    }
  });

  it('the structural loss is stated, not smoothed over', () => {
    // Chat's flatness is the defining mismatch. If the team rows ever stop being lost,
    // someone has invented a hierarchy that does not exist.
    const teamRow = TEAMS_MESSAGING.find((r) => r.operationId === 'ListJoinedTeams');
    expect(teamRow?.fidelity).toBe('lost');
    expect(teamRow?.target).toBeNull();
    // ...and it must say the keep-Teams path still has it, or the customer cannot see that
    // choosing differently would preserve it.
    expect(teamRow?.graph?.tool).toBeTruthy();
  });

  it('interactive cards are never claimed', () => {
    const card = TEAMS_MESSAGING.find((r) => r.operationId === 'PostCardInChatOrChannel');
    expect(card?.fidelity).toBe('narrowed');
    expect(card?.reason?.toLowerCase()).toContain('display only');
  });

  it('bucketed rows state their operation count in the id', () => {
    // A bucket that does not say how many operations it covers lets 16 unbuilt operations
    // read as one line item.
    for (const r of TEAMS_MESSAGING.filter((x) => x.operationId.startsWith('('))) {
      expect(r.operationId, `${r.operationId} does not state a count`).toMatch(/\d+/);
    }
  });
});

describe('operation ids that real agents actually declare', () => {
  // Every id here was OBSERVED on a customer-built agent, not read off documentation. The
  // table originally guessed "PostMessageToMyself"; Copilot emits "PostMessageToSelf", and
  // the mismatch reported a mapped operation as unmapped.
  // GetAllChannelsForTeam (6 agents) and GetChats (6 agents) were measured on staged agents
  // and resolved to NOTHING until 2026-08-20 — the verdicts existed under the ListChannels
  // and ListChats rows, only the spellings the agents use were missing.
  const OBSERVED = [
    'PostMessageToSelf', 'PostMessageToConversation', 'GetTeam', 'CreateChat',
    'GetAllChannelsForTeam', 'GetChats',
  ];

  it('resolves every operation id seen on the "Teams Coordinator" agent', () => {
    for (const op of OBSERVED) {
      expect(findEquivalence('teams', op), `${op} resolves to nothing`).toBeTruthy();
    }
  });

  it('maps a connector id to its surface instead of leaving it to the caller', () => {
    // A caller hardcoding 'outlook' for a Teams agent made all four operations report as
    // unmapped, with the outlook reason text attached — a confident wrong answer.
    expect(surfaceForConnector('shared_teams')).toBe('teams');
    expect(surfaceForConnector('shared_googlechat')).toBe('teams');
    expect(surfaceForConnector('shared_office365')).toBe('outlook');
    expect(surfaceForConnector('shared_outlook')).toBe('outlook');
    expect(surfaceForConnector('shared_jira')).toBeNull();
    // shared_onedrive is the id the REGISTRY defines; the switch previously matched only
    // 'shared_onedriveforbusiness', which exists nowhere, so OneDrive agents fell to null and
    // every operation they declared was reported unjudged.
    expect(surfaceForConnector('shared_onedrive')).toBe('onedrive');
    expect(REGISTRY_BY_ID.has('shared_onedrive'), 'the id the switch maps must be a real registry id').toBe(true);
    expect(REGISTRY_BY_ID.has('shared_onedriveforbusiness'), 'the old spelling is not a registry id').toBe(false);
  });

  it('the two spellings resolve to the verdicts they belong to, not to new ones', () => {
    // A second row per operation would have been the easy fix and the wrong one: the report
    // would then answer by array order. These must land on the EXISTING rows.
    expect(findEquivalence('teams', 'GetAllChannelsForTeam')?.operationId).toBe('ListChannels');
    expect(findEquivalence('teams', 'GetChats')?.operationId).toBe('ListChats');
    // ...and the keep-Microsoft path for both is now proven, which is what a customer
    // choosing "stay on Teams" is relying on.
    expect(findEquivalence('teams', 'GetAllChannelsForTeam')?.graph?.verified).toBe(true);
    expect(findEquivalence('teams', 'GetChats')?.graph?.verified).toBe(true);
  });

  it('GetTeam is honestly lost, not silently unmapped', () => {
    // The two look identical in a report but mean opposite things: "lost" is a judgement we
    // stand behind, "unmapped" means nobody looked.
    const e = findEquivalence('teams', 'GetTeam');
    expect(e?.fidelity).toBe('lost');
    expect(e?.reason).toMatch(/no team object/i);
  });
});

describe('Teams surface choice', () => {
  const teams = SURFACE_EQUIVALENTS.shared_teams;

  it('offers keep-Teams first', () => {
    // Same ordering rule as mail: the lower-risk option that changes least leads.
    expect(teams.targets[0].connectorId).toBe('shared_teams');
    expect(teams.targets[1].connectorId).toBe('shared_googlechat');
  });

  it('names both targets in the registry', () => {
    for (const t of teams.targets) {
      expect(REGISTRY_BY_ID.get(t.connectorId), `${t.connectorId} missing from registry`).toBeTruthy();
    }
  });

  it('states a prerequisite for each target, naming the real blocker', () => {
    for (const t of teams.targets) expect(t.prerequisite, `${t.name} has no prerequisite`).toBeTruthy();
    // This assertion originally required the word "protected", written when I believed
    // Microsoft's protected-APIs programme gated READING Teams messages. It does not —
    // reading worked app-only on the first try (2026-08-20). The real blocker is the write
    // side, so the test now asserts THAT, which is the thing a customer must see.
    expect(teams.targets[0].prerequisite).toMatch(/Teamwork\.Migrate\.All/);
    // And DWD for Chat is not assumed to work.
    expect(teams.targets[1].prerequisite).toMatch(/domain-wide delegation/i);
  });

  it('the keep-Teams summary does not borrow Google Chat losses', () => {
    // Overclaiming losses on the safer path is its own dishonesty — it pushes customers
    // toward a migration they did not need.
    const keep = teams.targets[0].summary.toLowerCase();
    expect(keep).not.toContain('flat');
    expect(keep).not.toContain('label');
  });

  it('the keep-Teams option states it cannot post', () => {
    // MEASURED 2026-08-20: app-only Graph returns 403 "requires one of Teamwork.Migrate.All"
    // for both channel posts and chat sends. An option named "Keep Teams" reads as "nothing
    // changes", so the lost write capability has to be in the name AND the summary or a
    // customer picks it expecting an agent that can still reply.
    expect(teams.targets[0].name.toLowerCase()).toContain('read-only');
    expect(teams.targets[0].summary.toLowerCase()).toContain('cannot');
    // ...and it must not offer a permission that would fix it, because none does.
    expect(teams.targets[0].prerequisite).toMatch(/delegated-only|no permission to add/i);
  });

  it('no Teams write-message tool is claimed anywhere', () => {
    // Guards against a future "restore the send tools" change that re-adds tools which
    // cannot work. If app-only posting ever becomes possible, re-probe and change this test
    // deliberately rather than deleting it.
    const banned = ['teams_send_channel_message', 'teams_send_chat_message', 'teams_reply_to_channel_message'];
    for (const r of TEAMS_MESSAGING) {
      if (r.graph?.tool) expect(banned, `${r.operationId} names an impossible tool`).not.toContain(r.graph.tool);
    }
  });

  it('Google Chat is identified as the only path that can still send', () => {
    expect(teams.targets[1].summary.toLowerCase()).toContain('only path');
  });

  it('the Chat prerequisite separates reading from posting', () => {
    // MEASURED 2026-08-20: DWD reads work, but message creation returns 404 "Google Chat app
    // not found" until a Chat app is configured on the Cloud project. A customer who grants
    // only the scopes will read fine and never be able to post, so both steps must be named
    // or the failure looks like our bug.
    const pre = teams.targets[1].prerequisite ?? '';
    expect(pre).toMatch(/chat app/i);
    expect(pre.toLowerCase()).toContain('posting');
    expect(pre.toLowerCase()).toContain('reading');
  });

  it('the Google Chat summary names the flatness problem up front', () => {
    expect(teams.targets[1].summary.toLowerCase()).toContain('flat');
  });

  it('every surface declares a noun so no agent is told it lacks "mail" tools', () => {
    for (const [id, eq] of Object.entries(SURFACE_EQUIVALENTS)) {
      expect(eq.noun, `${id} has no noun`).toBeTruthy();
    }
    expect(SURFACE_EQUIVALENTS.shared_teams.noun).not.toContain('mail');
  });
});
