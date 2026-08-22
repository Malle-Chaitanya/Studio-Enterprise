import { describe, it, expect } from 'vitest';
import {
  SURFACE_EQUIVALENTS,
  resolveSurfaceTarget,
  getAgentSurfaceChoice,
  listAgentSurfaceChoices,
  saveAgentSurfaceChoice,
} from './agentSurfaceChoice.js';

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
        expect(t.connectorId).toMatch(/^shared_/);
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
