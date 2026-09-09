import { describe, it, expect } from 'vitest';
import { SURFACE_EQUIVALENTS } from '../db/repos/agentSurfaceChoice.js';

/**
 * Guards the rule orchestrator.ts:2193 applies: a surface connector is removed from the
 * default per-connector wiring path ONLY when it is proxy-only. A connector whose "keep
 * this" target is its own id has no substitution to wire it — the Keep branch is a no-op —
 * so excluding it deploys the agent with that capability silently missing.
 */
const baseOf = (key: string) => (key.includes(':') ? key.slice(0, key.indexOf(':')) : key);
const keepsOwn = (key: string) =>
  (SURFACE_EQUIVALENTS[key]?.targets ?? []).some((t) => t.connectorId === baseOf(key));

describe('surface connector wiring exclusion', () => {
  it('excludes shared_office365 — proxy-only, every target is a different connector', () => {
    expect(keepsOwn('shared_office365')).toBe(false);
  });

  it('does NOT exclude Dataverse — "Keep Dataverse" targets its own id', () => {
    // Deal Desk 3 shipped with zero Dataverse tools because this was excluded.
    expect(keepsOwn('shared_commondataserviceforapps')).toBe(true);
  });

  it('does NOT exclude Teams — "keep Microsoft" targets its own id', () => {
    expect(keepsOwn('shared_teams')).toBe(true);
  });

  it('every entry that keeps its own id offers that as a real target', () => {
    for (const key of Object.keys(SURFACE_EQUIVALENTS)) {
      const targets = SURFACE_EQUIVALENTS[key].targets;
      expect(targets.length, `${key} has no targets`).toBeGreaterThan(0);
      // A connector kept under its own id must be reachable by the default path; one that
      // is not must have somewhere else to go, or the agent loses the capability entirely.
      expect(keepsOwn(key) || targets.some((t) => t.connectorId !== baseOf(key))).toBe(true);
    }
  });
});
