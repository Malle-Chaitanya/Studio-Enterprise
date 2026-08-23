import { describe, it, expect } from 'vitest';
import { normalizeSelection, selectionFor } from './migrate.js';

/**
 * Which agents the customer picked, and when the server learns it.
 *
 * This is pinned because the answer being empty is INVISIBLE rather than loud. The
 * Connectors screen hides its per-agent panel when the selection is empty
 * (AgentDecisions.tsx returns null), so on 2026-08-23 a live WorkMate migration was
 * never offered the Teams or Drive decisions, silently dropped both tools, and reported
 * them afterwards as "no decision recorded". Nothing errored at any point.
 *
 * The cause was that `selection` read only `session.plan`, and in v2 the plan is written
 * by POST /plan — which runs when the migration STARTS, after the screens that need it.
 */
describe('selectionFor', () => {
  it('prefers the recorded selection over the last run plan', () => {
    // The plan describes the PREVIOUS run. Answering with it would show decision rows for
    // agents this run is not going to migrate, which is worse than showing none.
    const sel = selectionFor({
      agentSelection: [{ envUrl: 'https://a.crm.dynamics.com', botIds: ['new-1'] }],
      plan: { units: [{ envUrl: 'https://a.crm.dynamics.com', bots: [{ botid: 'old-1' }] }] },
    });
    expect(sel).toEqual([{ env: 'https://a.crm.dynamics.com', envName: undefined, botIds: ['new-1'] }]);
  });

  it('falls back to the plan when nothing was recorded', () => {
    // The v1 wizard never posts a selection, so it must keep working off the plan alone.
    const sel = selectionFor({
      plan: { units: [{ envUrl: 'https://a.crm.dynamics.com', envName: 'Prod', bots: [{ botid: 'b1' }] }] },
    });
    expect(sel).toEqual([{ env: 'https://a.crm.dynamics.com', envName: 'Prod', botIds: ['b1'] }]);
  });

  it('answers empty for a session with neither, without throwing', () => {
    // A first-pass session. Empty is the honest answer; the caller decides what to show.
    expect(selectionFor({})).toEqual([]);
  });

  it('does not let an empty recorded selection mask a real plan', () => {
    // agentSelection: [] must not win over a plan that actually says something, or
    // clearing a selection would blank a screen that had a truthful answer available.
    const sel = selectionFor({
      agentSelection: [],
      plan: { units: [{ envUrl: 'https://a.crm.dynamics.com', bots: [{ botid: 'b1' }] }] },
    });
    expect(sel).toEqual([{ env: 'https://a.crm.dynamics.com', envName: undefined, botIds: ['b1'] }]);
  });

  it('carries every environment, not just the first', () => {
    const sel = selectionFor({
      agentSelection: [
        { envUrl: 'https://a.crm.dynamics.com', botIds: ['a1'] },
        { envUrl: 'https://b.crm.dynamics.com', botIds: ['b1', 'b2'] },
      ],
    });
    expect(sel.map((u) => u.env)).toEqual(['https://a.crm.dynamics.com', 'https://b.crm.dynamics.com']);
    expect(sel[1].botIds).toEqual(['b1', 'b2']);
  });
});

describe('normalizeSelection', () => {
  it('keeps a well-formed selection intact', () => {
    expect(normalizeSelection([{ env: 'https://a', envName: 'Prod', botIds: ['x', 'y'] }])).toEqual([
      { envUrl: 'https://a', envName: 'Prod', botIds: ['x', 'y'] },
    ]);
  });

  it('drops a unit with no agents rather than storing it', () => {
    // A unit with no bots is not a choice. Stored, it would make the selection look
    // present while answering nothing — the exact failure this field exists to remove.
    expect(normalizeSelection([{ env: 'https://a', botIds: [] }])).toEqual([]);
  });

  it('drops a unit with no environment', () => {
    expect(normalizeSelection([{ botIds: ['x'] }])).toEqual([]);
  });

  it('discards non-string bot ids instead of trusting the body', () => {
    // Request bodies are validated at the boundary in this codebase; a null in the array
    // would otherwise reach a Dataverse query as the string "null".
    expect(normalizeSelection([{ env: 'https://a', botIds: ['ok', null, 42, '', 'fine'] }])).toEqual([
      { envUrl: 'https://a', envName: undefined, botIds: ['ok', 'fine'] },
    ]);
  });

  it('returns empty for anything that is not an array', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      expect(normalizeSelection(bad)).toEqual([]);
    }
  });

  it('ignores a non-string envName rather than storing a number as a label', () => {
    expect(normalizeSelection([{ env: 'https://a', envName: 7, botIds: ['x'] }])).toEqual([
      { envUrl: 'https://a', envName: undefined, botIds: ['x'] },
    ]);
  });

  it('survives null entries in the array', () => {
    expect(normalizeSelection([null, { env: 'https://a', botIds: ['x'] }])).toEqual([
      { envUrl: 'https://a', envName: undefined, botIds: ['x'] },
    ]);
  });
});
