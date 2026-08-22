import { describe, it, expect } from 'vitest';
import { toSampleText } from './importReconcile.js';

/**
 * These guard a bug that cost two full migration runs.
 *
 * Discovery Engine returns per-document failures as `google.rpc.Status` — `code`,
 * `message`, `details`. Our type declared `{ errorMessage }`, which does not exist on that
 * shape, so every sample fell through to the string "unknown error". A 0/178 row import
 * reported its count and no cause, twice, while the API had told us the reason every time.
 *
 * The rule the fallback encodes: NEVER print a placeholder over data we were given. An
 * unrecognised shape must print itself, so the next run reveals the real field names
 * instead of hiding them again.
 */

describe('toSampleText', () => {
  it('reads google.rpc.Status.message — the shape Discovery Engine actually returns', () => {
    const t = toSampleText({ code: 3, message: 'Invalid value at document.struct_data' });
    expect(t).toContain('Invalid value at document.struct_data');
    expect(t).toContain('[3]');
    expect(t).not.toContain('unknown');
  });

  it('still reads the legacy errorMessage spelling', () => {
    expect(toSampleText({ errorMessage: 'quota exceeded' })).toContain('quota exceeded');
  });

  it('prefers message when both are present', () => {
    const t = toSampleText({ message: 'real reason', errorMessage: 'stale reason' });
    expect(t).toContain('real reason');
    expect(t).not.toContain('stale reason');
  });

  it('names the document so a failure is traceable to one row', () => {
    const t = toSampleText({
      document: 'projects/p/locations/l/dataStores/d/branches/0/documents/row-42',
      message: 'bad field',
    });
    expect(t).toContain('row-42');
    expect(t).toContain('bad field');
  });

  it('falls back to details when there is no message', () => {
    const t = toSampleText({ details: [{ reason: 'INVALID_ARGUMENT', field: 'struct_data' }] });
    expect(t).toContain('INVALID_ARGUMENT');
  });

  it('prints the RAW sample rather than a placeholder when the shape is unrecognised', () => {
    // The whole point: an unknown shape must reveal itself. "unknown error" is
    // indistinguishable from a bug in this function, which is exactly what happened.
    const t = toSampleText({ someNewField: 'surprise' } as never);
    expect(t).toContain('someNewField');
    expect(t).toContain('surprise');
    expect(t).toContain('unparsed');
  });

  it('never returns the bare string "unknown error"', () => {
    const shapes = [{}, { document: 'x/y/doc-1' }, { code: 7 }, { details: [] }];
    for (const s of shapes) {
      expect(toSampleText(s)).not.toBe('unknown error');
      expect(toSampleText(s).length).toBeGreaterThan(0);
    }
  });

  it('truncates a huge message instead of flooding the log', () => {
    const t = toSampleText({ details: [{ blob: 'x'.repeat(5000) }] });
    expect(t.length).toBeLessThan(400);
  });
});
