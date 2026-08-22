import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasDedicatedToolModule, connectorsHonouringBoundOperations } from './toolModule.js';

const PY = readFileSync(resolve('scripts/adk_deploy.py'), 'utf8');

/**
 * This module's whole job is to agree with a dispatch block in another language. If it drifts,
 * the pipeline goes back to promising exact-argument replays that the deploy discards —
 * which is what shipped an agent claiming four tools it did not have (2026-08-20).
 */
describe('tool-module detection tracks the Python dispatch', () => {
  it('every connector_tools module on disk is detected', () => {
    const files = readdirSync(resolve('scripts/connector_tools'))
      .filter((f) => f.endsWith('.py') && f !== '__init__.py' && f !== 'generic_rest.py')
      .map((f) => f.replace(/\.py$/, ''));
    expect(files.length).toBeGreaterThan(3);
    for (const kind of files) {
      expect(hasDedicatedToolModule(kind), `${kind}.py exists but was not detected`).toBe(true);
    }
  });

  it('every kind the Python dispatch names resolves to a module', () => {
    // Pull the kinds straight out of the dispatch so a newly handled kind fails here until
    // it is either aliased or given its own file.
    const kinds = new Set<string>();
    for (const m of PY.matchAll(/if kind (?:==|in) \(?((?:"[a-z0-9_]+",?\s*)+)\)?:/g)) {
      for (const q of m[1].matchAll(/"([a-z0-9_]+)"/g)) kinds.add(q[1]);
    }
    // ...and the prefix form, `if kind.startswith("hubspot")`, which the equality regex
    // above cannot see. A dispatch rule this file does not parse is a rule that can drift
    // unnoticed, which is the single failure mode this test exists for.
    for (const m of PY.matchAll(/if kind\.startswith\("([a-z0-9_]+)"\):/g)) kinds.add(m[1]);
    expect(kinds.size, 'no kinds parsed out of adk_deploy.py — the regex has gone stale').toBeGreaterThan(4);
    for (const kind of kinds) {
      expect(hasDedicatedToolModule(kind), `adk_deploy.py dispatches "${kind}" but no module resolves`).toBe(true);
    }
  });

  it('every HubSpot connector id in the registry resolves to the one module', () => {
    // Power Platform ships HubSpot as four connectors sharing one API and one token. If a
    // variant stopped resolving it would fall through to generic REST — the exact "call any
    // REST API" shape the model was measured refusing to use.
    for (const id of [
      'shared_hubspot', 'shared_hubspotcrm', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2',
    ]) {
      expect(hasDedicatedToolModule(id), `${id} does not resolve to hubspot.py`).toBe(true);
    }
    // The prefix is BROAD, and deliberately so: it matches any kind beginning "hubspot",
    // which is exactly what `kind.startswith("hubspot")` does in the Python. Asserted rather
    // than left implicit, because the two must agree — if this file ever narrowed the rule,
    // a future HubSpot variant would be promised bound operations here and given hubspot.py's
    // tools there.
    expect(hasDedicatedToolModule('hubspotsomethingnew')).toBe(true);
    expect(hasDedicatedToolModule('hubspo')).toBe(false);
  });

  it('generic_rest is the only consumer of boundOperations', () => {
    // The premise of the whole module. If a dedicated module starts reading boundOperations,
    // this file's assumption is wrong and the filter must be revisited rather than trusted.
    const dir = resolve('scripts/connector_tools');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.py'))) {
      const src = readFileSync(resolve(dir, f), 'utf8');
      if (f === 'generic_rest.py') {
        expect(src, 'generic_rest.py no longer reads boundOperations').toContain('boundOperations');
      } else {
        expect(src, `${f} now reads boundOperations — toolModule.ts assumes only generic_rest does`)
          .not.toContain('boundOperations');
      }
    }
  });

  it('an unknown kind falls through to generic REST, so its bound operations count', () => {
    // The robustness property: a connector nobody has written a module for still gets its
    // operations bound, and must therefore still be claimed and verified.
    expect(hasDedicatedToolModule('somethingnobodywrote')).toBe(false);
    expect(hasDedicatedToolModule('')).toBe(false);
  });

  it('strips the shared_ prefix so a connector id works as well as a kind', () => {
    expect(hasDedicatedToolModule('shared_teams')).toBe(hasDedicatedToolModule('teams'));
  });

  it('maps aliased kinds onto the file that really serves them', () => {
    // onedrive and sharepointonline are both sharepoint.py; chat and googlechat are both
    // chat.py. A plain <kind>.py check would miss these and re-introduce the false claim.
    for (const kind of ['onedrive', 'sharepointonline', 'sharepoint', 'googlechat', 'chat']) {
      expect(hasDedicatedToolModule(kind), `${kind} should resolve through an alias`).toBe(true);
    }
  });

  it('partitions a mixed connector set the way the deploy will', () => {
    const mixed = [
      { id: 'shared_teams', kind: 'teams' },
      { id: 'shared_googlechat', kind: 'googlechat' },
      { id: 'shared_jira', kind: 'jira' },
      { id: 'shared_somethingnew', kind: 'somethingnew' },
      { id: 'shared_customthing', kind: 'customthing' },
    ];
    const honoured = connectorsHonouringBoundOperations(mixed).map((c) => c.id);
    // Only the two with no module keep their bound operations.
    expect(honoured).toEqual(['shared_somethingnew', 'shared_customthing']);
  });
});
