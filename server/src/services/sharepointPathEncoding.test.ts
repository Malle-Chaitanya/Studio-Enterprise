import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SharePoint drive paths must be percent-encoded before they go into a Graph URL.
 *
 * Real SharePoint paths contain spaces and brackets as a matter of course — "Microsoft Teams
 * Chat Files", "Ben file 2[1]_1779290909_6257.pdf". urllib does not encode for you; it refuses
 * the request:
 *   URL can't contain control characters ... (found at least ' ')
 * Live 2026-08-22, a deployed agent's very first `sharepoint_list_files` call failed exactly
 * that way, which meant every SharePoint tool was unusable against any tenant whose folders
 * have spaces in their names — i.e. all of them.
 *
 * The module is Python and there is no Python test runner in this repo, so this asserts on the
 * source text. That is weaker than executing it, and it is deliberately narrow: it checks the
 * one construct that broke, rather than pretending to test behaviour it cannot reach. The same
 * grep-the-source approach is used by coverageReporting.test.ts, for the same reason — the
 * failure mode is something no passing run would notice.
 */
const SRC = readFileSync(join(process.cwd(), 'scripts', 'connector_tools', 'sharepoint.py'), 'utf8');

describe('sharepoint.py path encoding', () => {
  it('defines the _enc helper NESTED inside build_tools, not at module level', () => {
    // cloudpickle serialises nested closures by value and module-level functions by reference.
    // A module-level helper unpickles in the container as `connector_tools.sharepoint._enc`,
    // which does not resolve there, and the whole engine fails to start.
    const encLine = SRC.split('\n').findIndex((l) => l.includes('def _enc('));
    expect(encLine, '_enc must exist').toBeGreaterThan(-1);
    expect(SRC.split('\n')[encLine].startsWith('    def '), '_enc must be indented inside build_tools').toBe(true);
  });

  it('never interpolates a drive path into a Graph URL without encoding it', () => {
    // Every `root:/{...}` interpolation must wrap its value in _enc(...).
    const uses = [...SRC.matchAll(/root:\/\{([^}]*)\}/g)].map((m) => m[1]);
    expect(uses.length, 'expected at least one drive-path URL').toBeGreaterThan(0);
    for (const expr of uses) {
      expect(expr.includes('_enc('), `drive path interpolation "${expr}" is not encoded`).toBe(true);
    }
  });

  it('keeps "/" unescaped so the path stays a path', () => {
    // quote(p) with the default safe="/" is required: encoding the separators too would turn
    // "a/b" into a single literal segment and every nested lookup would 404.
    expect(SRC).toMatch(/quote\(p,\s*safe="\/"\)/);
  });

  it('resolves personal (OneDrive-for-Business) sites, not just team sites', () => {
    // Teams chat attachments live on a personal site — https://<tenant>-my.sharepoint.com/
    // personal/<user>/Documents/... — so any agent grounded on a file shared in a Teams chat
    // depends on this. Handling only "/sites/" sent the lookup to the -my host's ROOT site and
    // Graph answered 404, which the agent reported as "the folder is not configured": a parsing
    // bug wearing a setup problem's clothes. Confirmed live 2026-08-22.
    expect(SRC).toMatch(/\("sites",\s*"personal"\)/);
    // The matched segment must be carried into the site path, not hardcoded back to /sites/.
    expect(SRC).toMatch(/site_path = f"\/\{parts\[0\]\.lower\(\)\}\/\{parts\[1\]\}"/);
  });

  it('handles a scope that is a single FILE rather than a folder', () => {
    // Copilot authors do connect one document. Listing the children of a file is meaningless,
    // so the tool must detect it and return the file instead of an error.
    expect(SRC).toMatch(/if "file" in item/);
    expect(SRC).toMatch(/connected to a single file, not a folder/);
  });
});
