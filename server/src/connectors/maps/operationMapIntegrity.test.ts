import { describe, it, expect } from 'vitest';
import { lookupMapEntry } from '../operationMap.js';
import { OPERATION_MAP, OPERATION_UNMAPPABLE } from './index.js';

/**
 * The map and the unmappable table are one fact seen from two sides. Nothing enforced that
 * until now, and they drifted: `UpdateFile` gained a mapping when the upload host was
 * captured, but kept its "not yet captured" row, so the two tables disagreed about whether
 * the operation migrates. Only a probe read the table, so nothing broke -- which is exactly
 * how this bug class survives in this repo until a report starts consulting it.
 */
describe('operation map integrity', () => {
  it('never declares an operation both mapped and unmappable', () => {
    const contradictions: string[] = [];
    for (const [connectorId, reasons] of Object.entries(OPERATION_UNMAPPABLE)) {
      for (const operationId of Object.keys(reasons)) {
        // Via the real accessor, never by rebuilding the key here: the first version of
        // this test spelled it with one colon instead of `::`, matched nothing, and so
        // passed no matter how far the two tables drifted -- a test that proves nothing
        // is worse than no test, because it is counted as cover.
        if (lookupMapEntry(OPERATION_MAP, connectorId, operationId)) {
          contradictions.push(`${connectorId}:${operationId}`);
        }
      }
    }
    expect(contradictions).toEqual([]);
  });

  it('gives every unmappable operation a real reason', () => {
    for (const [connectorId, reasons] of Object.entries(OPERATION_UNMAPPABLE)) {
      for (const [operationId, why] of Object.entries(reasons)) {
        // A blank reason is worse than no row: the report would print nothing and look like
        // the operation was simply overlooked.
        expect(why.trim().length, `${connectorId}:${operationId}`).toBeGreaterThan(20);
      }
    }
  });
});
