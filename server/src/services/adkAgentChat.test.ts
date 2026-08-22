import { describe, it, expect } from 'vitest';
import { scanToolEvidence } from './adkAgentChat.js';

/**
 * `scanToolEvidence` is regex over the raw ADK event stream, and everything downstream
 * trusts it: `verify.ts` decides verified / failed / unknown from `succeeded`, `called`
 * and `names`. A parsing slip here does not throw — it silently changes a verdict.
 *
 * The failure that matters most is a FALSE `succeeded`. An agent whose retrieval 403s
 * every time, reported as verified, is precisely the bug this evidence-scanner was written
 * to end (ledger, agent 8277338168224151082).
 */

const call = (name: string) => `{"function_call":{"name":"${name}","args":{"q":"x"}}}`;
const okResponse = (name: string) =>
  `{"function_response":{"name":"${name}","response":{"result":"data"}}}`;
const errResponse = (name: string, msg: string) =>
  `{"function_response":{"name":"${name}","response":{"status":"error","error_message":"${msg}"}}}`;

describe('tool invocation detection', () => {
  it('reports no tools for a plain text turn', () => {
    const e = scanToolEvidence('{"content":{"parts":[{"text":"Hello there"}]}}');
    expect(e.called).toBe(false);
    expect(e.succeeded).toBe(false);
    expect(e.names).toEqual([]);
  });

  it('detects a call and captures its name', () => {
    const e = scanToolEvidence(call('jira_search'));
    expect(e.called).toBe(true);
    expect(e.names).toEqual(['jira_search']);
  });

  it('accepts the camelCase spelling the runtime also emits', () => {
    const e = scanToolEvidence('{"functionCall":{"name":"confluence_live_search","args":{}}}');
    expect(e.called).toBe(true);
    expect(e.names).toEqual(['confluence_live_search']);
  });

  it('captures a name that follows args rather than preceding it', () => {
    // Field order is not guaranteed, which is why the scan uses a window and not a
    // fixed-shape match.
    const e = scanToolEvidence('{"function_call":{"args":{"a":1,"b":2},"name":"late_name_tool"}}');
    expect(e.names).toEqual(['late_name_tool']);
  });

  it('dedupes a tool called several times in one turn', () => {
    const e = scanToolEvidence([call('jira_search'), call('jira_search')].join('\n'));
    expect(e.names).toEqual(['jira_search']);
  });

  it('captures every distinct tool in a multi-tool turn', () => {
    const e = scanToolEvidence([call('jira_search'), call('hubspot_list_companies')].join('\n'));
    expect(e.names.sort()).toEqual(['hubspot_list_companies', 'jira_search']);
  });
});

describe('success and failure evidence', () => {
  it('reports success on a clean function_response', () => {
    const e = scanToolEvidence([call('jira_search'), okResponse('jira_search')].join('\n'));
    expect(e.succeeded).toBe(true);
    expect(e.error).toBeUndefined();
  });

  it('extracts the tool error verbatim', () => {
    const e = scanToolEvidence(errResponse('search', 'PERMISSION_DENIED on servingConfigs.search'));
    expect(e.succeeded).toBe(false);
    expect(e.error).toContain('PERMISSION_DENIED');
  });

  it('counts runtime-side retrieval, which leaves no function_response', () => {
    const e = scanToolEvidence('{"groundingMetadata":{"groundingChunks":[{"retrievedContext":{"title":"Q1.pdf"}}]}}');
    expect(e.called).toBe(true);
    expect(e.succeeded).toBe(true);
  });

  it('does NOT count an empty groundingMetadata key as retrieval', () => {
    // The runtime emits this key empty on turns that retrieved nothing. Treating its mere
    // presence as success is how an ungrounded agent passes verification.
    const e = scanToolEvidence('{"groundingMetadata":{}}');
    expect(e.succeeded).toBe(false);
  });

  it('does not let a neighbouring success mask a failure', () => {
    // Windows are bounded at the NEXT response so one tool's outcome cannot bleed into
    // another's — a failing tool beside a passing one must still register as an error.
    const raw = [okResponse('good_tool'), errResponse('bad_tool', 'quota exceeded')].join('\n');
    const e = scanToolEvidence(raw);
    expect(e.error).toContain('quota exceeded');
  });

  it('does not let a failure hide a genuine success', () => {
    const raw = [errResponse('bad_tool', 'boom'), okResponse('good_tool')].join('\n');
    const e = scanToolEvidence(raw);
    expect(e.succeeded).toBe(true);
    expect(e.error).toContain('boom');
  });

  it('reports called-but-not-succeeded when a tool ran and only errored', () => {
    // This exact combination is what `verify.ts` turns into "the knowledge tool ran but
    // returned no usable result" rather than a pass.
    const e = scanToolEvidence([call('search'), errResponse('search', 'denied')].join('\n'));
    expect(e.called).toBe(true);
    expect(e.succeeded).toBe(false);
  });
});

describe('connector tool error payloads', () => {
  // Every tool in scripts/connector_tools/ reports failure as `return {"error": "..."}`.
  // That payload rides inside a perfectly well-formed function_response, so before this was
  // handled a failing connector tool scored succeeded=true and verify.ts marked it verified.
  // Caught live on 2026-08-19: a deployed agent said "the authentication to Outlook failed"
  // while the scanner called it a success.
  const connErr = (name: string, msg: string) =>
    `{"function_response":{"name":"${name}","response":{"error":"${msg}"}}}`;

  it('treats a connector {"error": ...} payload as a failure, not a success', () => {
    const e = scanToolEvidence(
      [call('outlook_search_messages'), connErr('outlook_search_messages', 'auth failed: 401')].join('\n'),
    );
    expect(e.called).toBe(true);
    expect(e.succeeded).toBe(false);
    expect(e.error).toContain('auth failed');
  });

  it('still reports success for a connector tool that returned data', () => {
    const e = scanToolEvidence(
      [call('gmail_search_messages'), okResponse('gmail_search_messages')].join('\n'),
    );
    expect(e.succeeded).toBe(true);
    expect(e.error).toBeUndefined();
  });

  it('does not let one succeeding tool mask another that errored', () => {
    const e = scanToolEvidence(
      [
        call('gmail_search_messages'),
        okResponse('gmail_search_messages'),
        call('outlook_send_message'),
        connErr('outlook_send_message', 'Outlook send failed: 403'),
      ].join('\n'),
    );
    expect(e.error).toContain('Outlook send failed');
  });
});

describe('robustness', () => {
  it('does not invent a name from a malformed frame', () => {
    const e = scanToolEvidence('{"function_call":{"args":{}}}');
    expect(e.called).toBe(true);
    expect(e.names).toEqual([]);
  });

  it('ignores an absurdly long name rather than capturing garbage', () => {
    const e = scanToolEvidence(`{"function_call":{"name":"${'x'.repeat(500)}"}}`);
    expect(e.names).toEqual([]);
  });

  it('handles an empty stream', () => {
    expect(scanToolEvidence('')).toEqual({ called: false, succeeded: false, error: undefined, names: [] });
  });
});
