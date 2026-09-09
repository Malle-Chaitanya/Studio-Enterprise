import { describe, it, expect } from 'vitest';
import {
  SURFACE_EQUIVALENTS,
  resolveSurfaceTarget,
  getAgentSurfaceChoice,
  listAgentSurfaceChoices,
  saveAgentSurfaceChoice,
  agentUsesSurface,
} from './agentSurfaceChoice.js';
import type { AgentIR, AgentToolIR } from '../../types.js';

const tool = (connectorId: string, operationId?: string): AgentToolIR =>
  ({ name: connectorId, kind: 'connector', connectorId, operationId }) as unknown as AgentToolIR;

const irWithTools = (agentTools: AgentToolIR[]): AgentIR => ({ agentTools }) as unknown as AgentIR;

/**
 * The behaviour under test is FAIL CLOSED.
 *
 * Every other connector is same-vendor and wiring it needs no permission. This one hands an
 * agent access to a person's MAILBOX. The rule is that only an explicit, recorded 'migrate'
 * wires it — not a default, not an inference from "the agent used Outlook, so obviously it
 * wants Gmail", and not a Mongo outage silently degrading into a yes.
 *
 * These run with no database connected, which is also the realistic worst case: the repo's
 * reads return null, and the question is what the resolver does with that.
 */

describe('resolveSurfaceTarget fails closed', () => {
  it('returns null for an unknown surface', async () => {
    expect(await resolveSurfaceTarget('u1', 'agent-1', 'shared_nonexistent')).toBeNull();
  });

  it('returns null when NO decision was recorded — silence is not consent', async () => {
    // The case that matters most: the agent genuinely uses Outlook, the surface is known,
    // and nobody has decided. It must not wire a mailbox.
    expect(await resolveSurfaceTarget('u1', 'agent-1', 'shared_office365')).toBeNull();
  });

  it('returns null when the database is unavailable', async () => {
    // A Mongo outage must not turn "undecided" into "migrate". Persistence here is
    // best-effort for WRITES; for this READ, unavailable has to mean no.
    expect(await resolveSurfaceTarget('u1', 'any-agent', 'shared_office365')).toBeNull();
    expect(await getAgentSurfaceChoice('u1', 'any-agent', 'shared_office365')).toBeNull();
  });

  it('degrades quietly rather than throwing when Mongo is down', async () => {
    // The pipeline must survive an outage — these are called mid-migration.
    await expect(listAgentSurfaceChoices('u1', ['a'])).resolves.toEqual([]);
    await expect(
      saveAgentSurfaceChoice({
        appUserId: 'u1',
        sourceId: 'a',
        sourceConnectorId: 'shared_office365',
        decision: 'migrate',
        targetConnectorId: 'shared_gmail',
        impersonateEmail: 'x@y.z',
      }),
    ).resolves.toBe(false);
  });
});

describe('Dataverse is the one surface that defaults instead of failing closed', () => {
  it('resolves to "Keep Dataverse" with no decision recorded and no database connected', async () => {
    // Dataverse's live tool already worked with zero decisions required before this choice
    // existed — failing it closed the same way mail does would regress every customer NOT
    // doing a tenant cutover the moment this shipped. This must hold even under the same
    // "no DB connected" worst case the block above tests mail against.
    expect(await resolveSurfaceTarget('u1', 'agent-1', 'shared_commondataserviceforapps'))
      .toEqual({ targetConnectorId: 'shared_commondataserviceforapps' });
  });

  it('does not affect any other surface\'s fail-closed behavior', () => {
    for (const [id, eq] of Object.entries(SURFACE_EQUIVALENTS)) {
      if (id === 'shared_commondataserviceforapps') continue;
      expect(eq.defaultDecision, id).toBeUndefined();
    }
  });

  it('is the only surface that does not require naming an identity', () => {
    const eq = SURFACE_EQUIVALENTS.shared_commondataserviceforapps;
    expect(eq.requiresIdentity).toBe(false);
    for (const [id, other] of Object.entries(SURFACE_EQUIVALENTS)) {
      if (id === 'shared_commondataserviceforapps') continue;
      expect(other.requiresIdentity, id).not.toBe(false);
    }
  });

  it('offers Keep Dataverse first, then Use Cloud SQL — staying put leads, same ordering as every other surface', () => {
    const eq = SURFACE_EQUIVALENTS.shared_commondataserviceforapps;
    expect(eq.targets[0].connectorId).toBe('shared_commondataserviceforapps');
    expect(eq.targets[1].connectorId).toBe('cloudsql');
  });
});

describe('SURFACE_EQUIVALENTS', () => {
  it('offers keeping the source platform as well as moving', () => {
    // The requirement that produced this shape: an agent with Outlook tools must be able to
    // migrate to Gemini while its MAIL stays in Microsoft. Gmail-or-nothing quietly forced a
    // mail migration on anyone who only wanted the agent moved.
    const outlook = SURFACE_EQUIVALENTS.shared_office365;
    const ids = outlook.targets.map((t) => t.connectorId);
    expect(ids).toContain('shared_outlook');
    expect(ids).toContain('shared_gmail');
  });

  it('offers staying put FIRST — the lower-risk option leads', () => {
    expect(SURFACE_EQUIVALENTS.shared_office365.targets[0].connectorId).toBe('shared_outlook');
  });

  it('every target states its trade-off before the customer chooses', () => {
    for (const eq of Object.values(SURFACE_EQUIVALENTS)) {
      for (const t of eq.targets) {
        // 'cloudsql' is the one deliberate exception: Dataverse's "Use Cloud SQL" target is
        // NOT a real registry connector (orchestrator.ts special-cases it, see
        // SURFACE_EQUIVALENTS.shared_commondataserviceforapps's own comment), so it is never
        // expected to look like one.
        if (t.connectorId !== 'cloudsql') expect(t.connectorId).toMatch(/^shared_/);
        expect(t.name.length).toBeGreaterThan(0);
        expect(t.summary.length).toBeGreaterThan(80);
      }
    }
  });

  it('names the admin prerequisite for each target, since both need one', () => {
    // Both paths need an admin grant first (Entra application permissions for Graph,
    // domain-wide delegation for Gmail). A customer who picks one and then finds out is a
    // customer we failed to warn.
    for (const t of SURFACE_EQUIVALENTS.shared_office365.targets) {
      expect(t.prerequisite, t.connectorId).toBeTruthy();
    }
  });

  it('the Gmail target names the label and flag losses', () => {
    const gmail = SURFACE_EQUIVALENTS.shared_office365.targets.find((t) => t.connectorId === 'shared_gmail');
    expect(gmail?.summary).toMatch(/label/i);
    expect(gmail?.summary).toMatch(/star|flag/i);
  });

  it('the Outlook target does NOT claim losses it does not have', () => {
    // Staying on Graph keeps folders and flags. Copying the Gmail caveats onto it would be
    // overclaiming in the other direction — scaring a customer off the safer option.
    const keep = SURFACE_EQUIVALENTS.shared_office365.targets.find((t) => t.connectorId === 'shared_outlook');
    expect(keep?.summary).toMatch(/folders stay folders|nothing about the mail behaviour changes/i);
  });
});

describe('agentUsesSurface — mail and calendar are independent decisions on one connector id', () => {
  // Real operationIds measured live 2026-08-31 against a real child agent ("Meeting
  // Scheduler Agent") — see connectors/equivalence.ts's OTHER_SURFACES rows for the same 4.
  const CALENDAR_OP = 'V4CalendarPostItem'; // Create event (V4)
  const MAIL_OP = 'SendEmailV2'; // an ordinary Outlook mail operation

  it('an agent with only mail tools does not trigger the calendar surface', () => {
    const ir = irWithTools([tool('shared_office365', MAIL_OP)]);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_office365:calendar')).toBe(false);
  });

  it('an agent with only calendar tools does not trigger the plain (mail) surface', () => {
    const ir = irWithTools([tool('shared_office365', CALENDAR_OP)]);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(false);
    expect(agentUsesSurface(ir, 'shared_office365:calendar')).toBe(true);
  });

  it('an agent with BOTH triggers both surfaces independently — the real WorkMate + Meeting Scheduler Agent shape', () => {
    const ir = irWithTools([tool('shared_office365', MAIL_OP), tool('shared_office365', CALENDAR_OP)]);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_office365:calendar')).toBe(true);
  });

  it('an agent that uses shared_office365 with no operationId at all still counts as mail, not calendar', () => {
    // A tool row extraction could not resolve an operationId for must not silently vanish
    // from "does this agent use mail" — it can only ever be excluded from calendar, which
    // requires a KNOWN calendar operationId to match.
    const ir = irWithTools([tool('shared_office365', undefined)]);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_office365:calendar')).toBe(false);
  });

  it('an unrelated connector (Teams) is unaffected by the calendar carve-out', () => {
    const ir = irWithTools([tool('shared_teams', 'ListChats')]);
    expect(agentUsesSurface(ir, 'shared_teams')).toBe(true);
  });

  it('an agent with no tools at all triggers no surface', () => {
    const ir = irWithTools([]);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(false);
    expect(agentUsesSurface(ir, 'shared_office365:calendar')).toBe(false);
  });

  it('the calendar surface is registered in SURFACE_EQUIVALENTS with both real targets', () => {
    const cal = SURFACE_EQUIVALENTS['shared_office365:calendar'];
    expect(cal).toBeTruthy();
    expect(cal.targets.map((t) => t.connectorId).sort()).toEqual(['shared_googlecalendar', 'shared_outlook']);
  });
});

describe('agentUsesSurface — contacts is a THIRD independent decision on the same connector id', () => {
  // Real operationId pulled 2026-09-01 from the captured swagger — see
  // connectors/equivalence.ts's contacts rows for the same set.
  const CONTACTS_OP = 'ContactGetItems_V2'; // Get contacts (V2)
  const CALENDAR_OP = 'V4CalendarPostItem'; // Create event (V4)
  const MAIL_OP = 'SendEmailV2'; // an ordinary Outlook mail operation

  it('an agent with only contacts tools does not trigger mail or calendar', () => {
    const ir = irWithTools([tool('shared_office365', CONTACTS_OP)]);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(false);
    expect(agentUsesSurface(ir, 'shared_office365:calendar')).toBe(false);
    expect(agentUsesSurface(ir, 'shared_office365:contacts')).toBe(true);
  });

  it('an agent with mail, calendar AND contacts triggers all three independently', () => {
    const ir = irWithTools([
      tool('shared_office365', MAIL_OP),
      tool('shared_office365', CALENDAR_OP),
      tool('shared_office365', CONTACTS_OP),
    ]);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_office365:calendar')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_office365:contacts')).toBe(true);
  });

  it('an agent with only mail tools does not trigger the contacts surface', () => {
    const ir = irWithTools([tool('shared_office365', MAIL_OP)]);
    expect(agentUsesSurface(ir, 'shared_office365:contacts')).toBe(false);
  });

  it('the contacts surface is registered in SURFACE_EQUIVALENTS with only the Google target — no Keep-Outlook option exists yet', () => {
    const contacts = SURFACE_EQUIVALENTS['shared_office365:contacts'];
    expect(contacts).toBeTruthy();
    expect(contacts.targets.map((t) => t.connectorId)).toEqual(['shared_googlecontacts']);
  });
});

/**
 * Work IQ MCP servers (Preview) — a365outlookmailmcp / a365outlookcalendarmcp.
 *
 * Unlike shared_office365, these are ALREADY separate connector ids per capability (no
 * composite ":calendar" key needed), confirmed live 2026-09-02 against the real Meeting
 * Intelligence Agent. agentUsesSurface's plain-key path must therefore tell them apart
 * from each other and from shared_office365 with no special-casing.
 */
describe('Work IQ MCP surfaces (a365outlookmailmcp / a365outlookcalendarmcp)', () => {
  it('an agent with only the Mail MCP tool triggers the mail surface, not calendar or office365', () => {
    const ir = irWithTools([tool('shared_a365outlookmailmcp', 'mcp_MailTools')]);
    expect(agentUsesSurface(ir, 'shared_a365outlookmailmcp')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_a365outlookcalendarmcp')).toBe(false);
    expect(agentUsesSurface(ir, 'shared_office365')).toBe(false);
  });

  it('an agent with only the Calendar MCP tool triggers the calendar surface, not mail', () => {
    const ir = irWithTools([tool('shared_a365outlookcalendarmcp', 'mcp_CalendarTools')]);
    expect(agentUsesSurface(ir, 'shared_a365outlookcalendarmcp')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_a365outlookmailmcp')).toBe(false);
  });

  it('an agent with both MCP tools triggers both surfaces independently — the real Meeting Intelligence Agent shape', () => {
    const ir = irWithTools([
      tool('shared_a365outlookmailmcp', 'mcp_MailTools'),
      tool('shared_a365outlookcalendarmcp', 'mcp_CalendarTools'),
    ]);
    expect(agentUsesSurface(ir, 'shared_a365outlookmailmcp')).toBe(true);
    expect(agentUsesSurface(ir, 'shared_a365outlookcalendarmcp')).toBe(true);
  });

  it('mail offers Keep Outlook first, then Gmail — same staying-put-leads ordering as office365', () => {
    const mail = SURFACE_EQUIVALENTS['shared_a365outlookmailmcp'];
    expect(mail).toBeTruthy();
    expect(mail.targets.map((t) => t.connectorId)).toEqual(['shared_outlook', 'shared_gmail']);
    for (const t of mail.targets) {
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.prerequisite?.length).toBeGreaterThan(0);
    }
  });

  it('calendar offers only Google Calendar — no Keep-Outlook-Calendar option exists yet (no Graph calendar module)', () => {
    const cal = SURFACE_EQUIVALENTS['shared_a365outlookcalendarmcp'];
    expect(cal).toBeTruthy();
    expect(cal.targets.map((t) => t.connectorId)).toEqual(['shared_googlecalendar']);
  });

  it('the calendar target is honest that meeting transcripts and AI insights do not migrate at all', () => {
    const cal = SURFACE_EQUIVALENTS['shared_a365outlookcalendarmcp'];
    const summary = cal.targets[0].summary;
    expect(summary).toMatch(/GetOnlineMeetingTranscripts/);
    expect(summary).toMatch(/GetOnlineMeetingAiInsights/);
    expect(summary).toMatch(/no google calendar equivalent/i);
  });
});
