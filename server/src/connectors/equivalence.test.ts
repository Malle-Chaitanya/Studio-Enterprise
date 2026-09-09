import { describe, it, expect } from 'vitest';
import {
  EQUIVALENCES,
  OUTLOOK_MAIL,
  summarise,
  findEquivalence,
  describeEquivalence,
  type Equivalence,
} from './equivalence.js';

/**
 * These are honesty tests, not shape tests.
 *
 * The equivalence table is the single source for what we TELL A CUSTOMER migrates. The
 * failure that matters is not a crash — it is a row that quietly overstates fidelity, or a
 * "narrowed" with no stated reason, which reads to a customer as "fine" and is discovered
 * as a defect months later. Every assertion below exists to make that impossible to add
 * without a test going red.
 */

describe('fidelity honesty', () => {
  it('every non-exact row states WHY, in a real sentence', () => {
    const bad = EQUIVALENCES.filter(
      (e) => e.fidelity !== 'exact' && (!e.reason || e.reason.trim().length < 25),
    );
    expect(
      bad.map((e) => e.operationId),
      'narrowed/lost rows must carry a customer-readable reason',
    ).toEqual([]);
  });

  it('every lost row has no target — a target implies it migrates somewhere', () => {
    for (const e of EQUIVALENCES.filter((x) => x.fidelity === 'lost')) {
      expect(e.target, `${e.operationId} is lost but names a target`).toBeNull();
    }
  });

  it('every non-lost row names a target', () => {
    for (const e of EQUIVALENCES.filter((x) => x.fidelity !== 'lost')) {
      expect(e.target, `${e.operationId} claims to migrate but names no target`).not.toBeNull();
    }
  });

  it('verified is opt-in — an unmarked row is NOT counted as proven', () => {
    // The default must be "not proven". If this ever inverts, every new row silently
    // claims a live proof nobody performed.
    const unmarked = EQUIVALENCES.filter((e) => e.verified === undefined);
    expect(unmarked.length).toBeGreaterThan(0);
    for (const e of unmarked) expect(Boolean(e.verified)).toBe(false);
  });

  it('only rows actually proven live are marked verified', () => {
    // A whole-table allow-list, so a `verified: true` added ANYWHERE fails here and has to
    // come with evidence. Two separate campaigns, deliberately listed apart:
    //
    // MAIL, 2026-08-19 against zara@storefuze.com — three read rows by _test_gmail_tools.ts,
    // the rest by _test_gmail_all_tools.ts (16 assertions, 0 failures, every message
    // self-addressed and trashed afterwards).
    const MAIL = [
      'AssignCategory', 'AssignCategoryBulk', 'DeleteEmail_V2', 'DraftEmail',
      'Flag_V2', 'ForwardEmail_V2', 'GetAttachment_V2', 'GetEmailV2', 'GetEmailsV3',
      'GetMailboxFolders', 'GetOutlookCategoryNames', 'MarkAsRead_V3', 'MoveV2',
      'ReplyToV3', 'SendDraftEmail', 'SendEmailV2', 'UpdateDraftEmail',
    ];
    // GOOGLE CHAT READS, 2026-08-20 — proven at the tool layer and again from a deployed
    // agent (RE 5722168023469522944) that named real spaces. Reads only: Chat writes return
    // 404 until a Chat app is configured on the project, so none of them appear here.
    const CHAT_READS = [
      'GetMessageDetails', 'GetMessagesInChannel', 'GetMessagesInChat',
      'ListChannels', 'ListChats', 'ListRepliesOfChannelMessage',
    ];
    // SHAREPOINT READS, 2026-08-20 — _test_sharepoint_all_tools.ts, 6 assertions, 0
    // failures, against the folder a real staged agent named. Nine lists came back WITH
    // names and a 12,547-character document was read back in full; "the call returned 200"
    // would not have earned either row, because both tools can succeed and return nothing
    // usable.
    const SHAREPOINT_READS = ['GetAllTables', 'ListFolderContents'];
    const verified = EQUIVALENCES.filter((e) => e.verified).map((e) => e.operationId).sort();
    expect(verified).toEqual([...MAIL, ...CHAT_READS, ...SHAREPOINT_READS].sort());
  });

  it('a verified row names the tool that proved it', () => {
    for (const e of EQUIVALENCES.filter((x) => x.verified)) {
      expect(e.tool, `${e.operationId} is verified but names no tool`).toBeTruthy();
    }
  });
});

describe('the mappings that are easy to get wrong', () => {
  it('Move is narrowed, never exact — folders and labels are different models', () => {
    const move = findEquivalence('outlook', 'MoveV2');
    expect(move?.fidelity).toBe('narrowed');
    expect(move?.reason).toMatch(/label/i);
  });

  it('Flag is narrowed — a due date cannot survive as a boolean star', () => {
    const flag = findEquivalence('outlook', 'Flag_V2');
    expect(flag?.fidelity).toBe('narrowed');
    expect(flag?.reason).toMatch(/due date/i);
  });

  it('Power Automate constructs are lost, not narrowed', () => {
    // These look like mail operations and are not. Grading them "narrowed" would promise a
    // customer something no vendor can deliver.
    for (const id of ['SendApprovalMail', 'SendMailWithOptions']) {
      const e = findEquivalence('outlook', id);
      expect(e?.fidelity, id).toBe('lost');
      expect(e?.target, id).toBeNull();
    }
  });

  it('delete maps to trash, and says so', () => {
    const del = findEquivalence('outlook', 'DeleteEmail_V2');
    expect(del?.target?.capability).toMatch(/trash/i);
    expect(del?.reason).toMatch(/recoverable|trash/i);
  });

  it('triggers are lost for an agent-platform reason, not a Google one', () => {
    const trig = EQUIVALENCES.find((e) => e.operationId.includes('trigger'));
    expect(trig?.fidelity).toBe('lost');
    // The distinction matters: a customer must not read this as "Google cannot do it".
    expect(trig?.reason).toMatch(/any agent platform|request\/response/i);
  });

  it('unknown operations return undefined rather than a default', () => {
    expect(findEquivalence('outlook', 'NoSuchOperation')).toBeUndefined();
  });
});

describe('describeEquivalence — the sentence a customer reads', () => {
  const row = (over: Partial<Equivalence>): Equivalence => ({
    surface: 'outlook',
    operationId: 'X',
    label: 'Thing',
    target: { service: 'gmail', capability: 'cap' },
    fidelity: 'exact',
    ...over,
  });

  it('never claims proof for an unverified row', () => {
    expect(describeEquivalence(row({}))).toContain('Not yet verified');
  });

  it('says so plainly when a row IS proven', () => {
    expect(describeEquivalence(row({ verified: true }))).toContain('Proven live.');
  });

  it('a lost row says it does not migrate, and never says "proven"', () => {
    const text = describeEquivalence(
      row({ fidelity: 'lost', target: null, reason: 'No equivalent exists anywhere.' }),
    );
    expect(text).toContain('does not migrate');
    expect(text).not.toMatch(/proven/i);
  });

  it('a narrowed row carries its limit into the sentence', () => {
    const text = describeEquivalence(
      row({ fidelity: 'narrowed', reason: 'Only the name survives.' }),
    );
    expect(text).toContain('with limits');
    expect(text).toContain('Only the name survives.');
  });
});

describe('summarise', () => {
  it('counts add up to the row total', () => {
    const s = summarise();
    expect(s.exact + s.narrowed + s.lost).toBe(s.total);
    expect(s.total).toBe(EQUIVALENCES.length);
  });

  it('verified never exceeds the number of rows that migrate at all', () => {
    const s = summarise();
    expect(s.verified).toBeLessThanOrEqual(s.exact + s.narrowed);
  });

  it('works on a subset', () => {
    const s = summarise(OUTLOOK_MAIL);
    expect(s.total).toBe(OUTLOOK_MAIL.length);
    expect(s.lost).toBeGreaterThan(0);
  });
});

describe('mapped is not built, and built is not proven', () => {
  /**
   * The customer-facing doc once said "20 of 23 mail capabilities migrate — 87%". True as a
   * statement about mappings, and read by anyone sane as "87% works". What worked was three
   * operations. These tests exist so the three numbers can never be collapsed back into one.
   */
  it('reports mapped, built and verified as separate counts', () => {
    const s = summarise(OUTLOOK_MAIL);
    const mapped = s.exact + s.narrowed;
    // Mapped must always cover built, and built must always cover verified. Equality is
    // legitimate once the work is done — what must never happen is verified > built, which
    // would mean claiming a proof for something with no code behind it.
    expect(mapped).toBeGreaterThanOrEqual(s.built);
    expect(s.built).toBeGreaterThanOrEqual(s.verified);
  });

  it('a row cannot be verified without a tool — proof requires something to call', () => {
    for (const e of EQUIVALENCES.filter((x) => x.verified)) {
      expect(e.tool, `${e.operationId} claims proof but names no tool`).toBeTruthy();
    }
  });

  it('a mapped row with no tool is honest, not a bug', () => {
    // Most rows are design-only. That is the accurate state of the world and must not be
    // "fixed" by inventing tool names.
    const designOnly = OUTLOOK_MAIL.filter((r) => r.fidelity !== 'lost' && !r.tool);
    expect(designOnly.length).toBeGreaterThan(0);
    for (const e of designOnly) expect(Boolean(e.verified)).toBe(false);
  });

  it('lost rows are never built or verified', () => {
    for (const e of EQUIVALENCES.filter((x) => x.fidelity === 'lost')) {
      expect(e.tool, `${e.operationId}`).toBeUndefined();
      expect(Boolean(e.verified), `${e.operationId}`).toBe(false);
    }
  });
});

describe('the keep-Microsoft path is mapped too', () => {
  /**
   * "Map the API correctly" has TWO answers per operation, not one: where the call goes if
   * the mail stays in Microsoft 365, and where it goes if it moves to Google. A table with
   * only the Google column silently implies moving mail is the only option.
   *
   * None of this moves a single message. Both columns name an API the migrated agent CALLS
   * at conversation time.
   */
  it('every mail operation that migrates names its Graph call', () => {
    const missing = OUTLOOK_MAIL
      .filter((r) => r.fidelity !== 'lost' && !r.graph)
      .map((r) => r.operationId);
    expect(missing, 'these have a Gmail mapping but no Microsoft Graph mapping').toEqual([]);
  });

  it('a Graph mapping names a real Graph path or operation', () => {
    for (const r of OUTLOOK_MAIL.filter((x) => x.graph)) {
      expect(r.graph!.capability, r.operationId).toMatch(/\/users\/|message\.|getMailTips/);
    }
  });

  it('operations narrowed against Gmail are still available on Graph', () => {
    // The point of keeping Outlook: Move, Flag and categories lose information against Gmail
    // (folders vs labels, due dates, colours) and lose NOTHING against Graph.
    for (const id of ['MoveV2', 'Flag_V2', 'AssignCategoryBulk']) {
      const row = findEquivalence('outlook', id);
      expect(row?.fidelity, id).toBe('narrowed');
      expect(row?.graph?.tool, `${id} should have a Graph tool`).toBeTruthy();
    }
  });

  it('MailTips is reachable on Graph even though it is lost against Gmail', () => {
    // Worth stating precisely: this is not "impossible", it is "impossible on Google". A
    // customer keeping Outlook keeps it.
    const tips = findEquivalence('outlook', 'GetMailTips_V2');
    expect(tips?.fidelity).toBe('lost');
    expect(tips?.target).toBeNull();
    expect(tips?.graph?.capability).toContain('getMailTips');
  });

  it('a Graph mapping is only marked verified when a real tool backs it', () => {
    // `verified` means "we called this against a live tenant and it worked" — never "we
    // believe the mapping is right". A row with no tool has nothing that COULD have been
    // called, so it must not claim verification.
    for (const r of OUTLOOK_MAIL.filter((x) => x.graph)) {
      if (r.graph!.verified) {
        expect(r.graph!.tool, `${r.operationId} claims verified with no tool`).toBeTruthy();
      }
    }
  });

  it('the calendar row is proven on Graph, has a real Google tool, but is not yet verified live', () => {
    // This test previously asserted the OPPOSITE — that the row must not claim Graph proof —
    // because Graph answered ErrorAccessDenied on 2026-08-20 with Calendars.Read unconsented.
    // The grant was made and the call re-run on 2026-08-21, so the claim is now earned.
    //
    // UPDATED 2026-08-31: connector_tools/calendar.py now exists (Google Calendar
    // events.list/events.insert/freebusy.query — officially confirmed to need nothing beyond
    // a standard OAuth scope, so "NOT BUILT" was an implementation gap, not a platform one).
    // What must NOT drift now: the Google path has real CODE but has not yet had a live call
    // made and its result recorded, so `verified` stays false until that happens — a written
    // module is not the same claim as a proven one.
    const cal = findEquivalence('outlook', 'GetEventsCalendarViewV3');
    expect(cal, 'GetEventsCalendarViewV3 resolves to nothing').toBeTruthy();
    expect(cal!.graph?.tool).toBe('outlook_list_calendar_events');
    expect(cal!.graph?.verified, 'the Graph path was proven live — see ledger 1.52').toBe(true);
    // The GOOGLE path now has a real tool (built, not yet proven) — this must stay in sync
    // with connector_tools/calendar.py, not silently drift back to "no tool at all".
    expect(cal!.tool, 'the Google path should name calendar_list_events now that it exists').toBe('calendar_list_events');
    expect(Boolean(cal!.verified), 'the module is written but no live call has been recorded yet').toBe(false);
  });

  it('a bucket row never re-counts an operation that got its own row', () => {
    // Pulling GetEventsCalendarViewV3, CalendarGetTables_V2, FindMeetingTimes_V2, and
    // V4CalendarPostItem out of "(35 calendar operations)" without decrementing the bucket
    // would count them twice and overstate the unexamined remainder. Decremented again
    // 2026-09-01 (31 -> 28) when V3CalendarGetItem, V4CalendarPatchItem and
    // RespondToEvent_V2 got their own rows too.
    const bucket = EQUIVALENCES.find((r) => r.operationId.startsWith('(') && /calendar/i.test(r.operationId));
    expect(bucket?.operationId).toContain('28');
    // The bucket must not also answer for any operation that now has a row of its own.
    for (const op of [
      'GetEventsCalendarViewV3',
      'CalendarGetTables_V2',
      'FindMeetingTimes_V2',
      'V4CalendarPostItem',
      'V3CalendarGetItem',
      'V4CalendarPatchItem',
      'RespondToEvent_V2',
      'GetRooms_V2',
    ]) {
      expect((bucket?.covers ?? []).includes(op), `${op} should not double-count in the bucket`).toBe(false);
    }
  });

  it('the six newly-measured calendar operations resolve and are honestly unverified', () => {
    // Measured live 2026-08-31 / pulled from the captured swagger 2026-09-01 — not guessed
    // names. See connector_tools/calendar.py's module docstring for context.
    for (const [opId, tool] of [
      ['CalendarGetTables_V2', 'calendar_list_calendars'],
      ['FindMeetingTimes_V2', 'calendar_check_availability'],
      ['V4CalendarPostItem', 'calendar_create_event'],
      ['V3CalendarGetItem', 'calendar_get_event'],
      ['V4CalendarPatchItem', 'calendar_update_event'],
      ['RespondToEvent_V2', 'calendar_respond_to_event'],
    ] as const) {
      const row = findEquivalence('outlook', opId);
      expect(row, `${opId} resolves to nothing`).toBeTruthy();
      expect(row!.tool).toBe(tool);
      // Written this session, not yet exercised against a live Google Calendar — the
      // honesty gate must not let a fresh module claim proof it does not have.
      expect(Boolean(row!.verified), `${opId} should not claim verified before a real call is made`).toBe(false);
    }
  });

  it('GetRooms_V2 is honestly lost, not silently built', () => {
    // A different API (Admin Directory) and a different scope from every other calendar
    // tool in this table — not a gap that connector_tools/calendar.py can close.
    const row = findEquivalence('outlook', 'GetRooms_V2');
    expect(row, 'GetRooms_V2 resolves to nothing').toBeTruthy();
    expect(row!.fidelity).toBe('lost');
    expect(row!.target).toBeNull();
    expect(row!.tool).toBeUndefined();
  });

  it('the five Google Contacts operations resolve to contacts.py tools, honestly unverified', () => {
    // Real operationIds pulled 2026-09-01 from the captured swagger — see
    // connector_tools/contacts.py's module docstring for context. The contacts scope has
    // not been authorised in DWD for any customer yet, so none of these can be verified.
    for (const [opId, tool] of [
      ['ContactPostItem_V2', 'contacts_create_contact'],
      ['ContactGetItem_V2', 'contacts_get_contact'],
      ['ContactGetTablesV2', 'contacts_list_contact_groups'],
      ['ContactGetItems_V2', 'contacts_list_contacts'],
      ['ContactPatchItem_V2', 'contacts_update_contact'],
    ] as const) {
      const row = findEquivalence('outlook', opId);
      expect(row, `${opId} resolves to nothing`).toBeTruthy();
      expect(row!.tool).toBe(tool);
      expect(Boolean(row!.verified), `${opId} should not claim verified before a real call is made`).toBe(false);
    }
  });

  it('every Graph mapping that names a tool is proven live', () => {
    // All 14 Outlook tools were exercised against a real mailbox on 2026-08-19 (15 passing
    // assertions, 0 failures) — see ledger 1.46. If a NEW Graph tool is added, this fails
    // until it is actually run, which is the point.
    for (const r of OUTLOOK_MAIL.filter((x) => x.graph?.tool)) {
      expect(r.graph!.verified, `${r.operationId} names a tool but is unproven`).toBe(true);
    }
  });
});
