import { describe, it, expect } from 'vitest';
import { soleProject } from './envPairings.js';

/**
 * Which project a customer's credentials belong in.
 *
 * A secret has to be written to one specific project, but the pairing is per ENVIRONMENT —
 * so this is the one place that can legitimately answer "I cannot say". It must answer that
 * rather than pick, because picking writes a customer's token into a project they did not
 * choose for it, which is the failure the whole pairing route exists to end.
 */
describe('soleProject', () => {
  it('answers the project when every environment agrees', () => {
    expect(soleProject([{ project: 'acme-gemini' }, { project: 'acme-gemini' }])).toBe('acme-gemini');
  });

  it('refuses to choose when environments point at different projects', () => {
    expect(soleProject([{ project: 'acme-gemini' }, { project: 'acme-pilot' }])).toBeNull();
  });

  it('answers for a single pairing', () => {
    expect(soleProject([{ project: 'acme-gemini' }])).toBe('acme-gemini');
  });

  it('answers null for nothing paired, rather than an empty project id', () => {
    // '' would read as a real answer downstream and resolve to "no project" silently.
    expect(soleProject([])).toBeNull();
  });

  it('ignores a half-made pairing with no project', () => {
    expect(soleProject([{ project: 'acme-gemini' }, { project: '' }])).toBe('acme-gemini');
  });
});
