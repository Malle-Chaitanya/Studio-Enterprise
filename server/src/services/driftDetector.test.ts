import { describe, it, expect } from 'vitest';
import { detectDrift, snapshotFrom, type DriftSnapshot } from './driftDetector.js';
import type { AgentIR } from '../types.js';

function ir(over: Partial<AgentIR> = {}): AgentIR {
  return {
    sourceId: 'bdf9b817-9b90-f111-b8da-0022480b1f83',
    name: 'knowledge Nexus',
    instructions: 'Answer questions about migrations.',
    description: 'A migration helper.',
    capabilities: { webBrowsing: false, codeInterpreter: false },
    starterPrompts: ['Hello'],
    topics: [],
    knowledgeSources: [],
    unmapped: [],
    ...over,
  } as AgentIR;
}

describe('driftDetector — rename detection', () => {
  it('reports drift when the source agent was renamed', () => {
    // The live case (2026-08-13): the Copilot agent was renamed AA -> A -> "knowledge
    // Nexus" while Gemini still held "A". Before `name` was part of the snapshot this
    // returned changed:false, the run skipped with "already exists", and the customer
    // was told an agent existed under a name that had never been written.
    const prev = snapshotFrom(ir({ name: 'A' }));
    const result = detectDrift(prev, ir({ name: 'knowledge Nexus' }));

    expect(result.changed).toBe(true);
    expect(result.reasons).toContainEqual('renamed ("A" -> "knowledge Nexus")');
  });

  it('reports no drift when nothing changed, rename check included', () => {
    const prev = snapshotFrom(ir());
    expect(detectDrift(prev, ir())).toEqual({ changed: false, reasons: [] });
  });

  it('does NOT report a rename for snapshots written before `name` was recorded', () => {
    // Every agent migrated before this field shipped has a snapshot with no `name`.
    // Treating that absence as "" would report a rename for all of them at once and
    // redeploy the entire estate on the first re-run after release.
    const legacy = snapshotFrom(ir({ name: 'A' }));
    delete (legacy as Partial<DriftSnapshot>).name;

    const result = detectDrift(legacy as DriftSnapshot, ir({ name: 'knowledge Nexus' }));

    expect(result.changed).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('still detects a real content change on a legacy snapshot', () => {
    // The legacy allowance is narrow: it silences the NAME comparison only. A missing
    // name must not turn into a blanket "skip every check".
    const legacy = snapshotFrom(ir());
    delete (legacy as Partial<DriftSnapshot>).name;

    const result = detectDrift(legacy as DriftSnapshot, ir({ instructions: 'Something else entirely.' }));

    expect(result.changed).toBe(true);
    expect(result.reasons).toContainEqual('instructions changed');
  });

  it('records the name once a legacy snapshot is refreshed, arming rename detection', () => {
    const legacy = snapshotFrom(ir({ name: 'A' }));
    delete (legacy as Partial<DriftSnapshot>).name;
    expect(detectDrift(legacy as DriftSnapshot, ir({ name: 'A' })).changed).toBe(false);

    // A redeploy writes a fresh snapshot, which now carries the name.
    const refreshed = snapshotFrom(ir({ name: 'A' }));
    expect(refreshed.name).toBe('A');
    expect(detectDrift(refreshed, ir({ name: 'knowledge Nexus' })).changed).toBe(true);
  });
});
