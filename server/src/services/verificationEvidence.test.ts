import { describe, it, expect } from 'vitest';
import { classifyEvidence } from './verify.js';

/**
 * The verdict that decides what a customer is told about their migrated agent.
 *
 * Three of these four states are routinely collapsed into "verified", and each collapse
 * hides a different real failure. The one worth the most care is `wrong_agent_tools`: on
 * 2026-08-21 two agents deployed from the same GCS pickle and one answered using the
 * other's toolset, while every surface signal — HTTP 200, deployed, correctly named, gave a
 * fluent answer — was green. Only the tool names differed.
 *
 * This classifier is pure so the rule can be tested without a deployment, and it lives
 * server-side so a screen cannot reach a different verdict than the report. A UI calling
 * something verified that the report calls failed is worse than either being wrong alone.
 */
describe('classifyEvidence', () => {
  it('confirms tools when what fired is what was wired', () => {
    const e = classifyEvidence(['jira_search', 'jira_get_issue'], ['jira_search'], true, true);
    expect(e.verdict).toBe('tools_confirmed');
    expect(e.unexpected).toEqual([]);
    expect(e.missing).toEqual(['jira_get_issue']);
  });

  it('flags ANOTHER agent\'s tools as wrong_agent_tools, not as verified', () => {
    // The live case: a HubSpot agent answering with Email Manager's Outlook tools.
    const e = classifyEvidence(
      ['get_deals', 'get_contacts'],
      ['outlook_list_messages', 'outlook_send_mail'],
      true,
      true,
    );
    expect(e.verdict).toBe('wrong_agent_tools');
    expect(e.unexpected).toEqual(['outlook_list_messages', 'outlook_send_mail']);
    expect(e.missing).toEqual(['get_deals', 'get_contacts']);
  });

  it('does NOT cry wrong-agent on a partial overlap', () => {
    // A missing tool is an ordinary gap. Reporting it as a swapped package would turn every
    // routine shortfall into the scariest verdict available, and the verdict would stop
    // meaning anything.
    const e = classifyEvidence(
      ['jira_search', 'jira_get_issue'],
      ['jira_search', 'transfer_to_agent'],
      true,
      true,
    );
    expect(e.verdict).toBe('tools_confirmed');
    expect(e.unexpected).toEqual(['transfer_to_agent']);
  });

  it('treats prose with no frames as unproven, never as a pass', () => {
    // A model can describe an inbox it never opened. Listing tool names is not evidence
    // that the tools exist.
    const e = classifyEvidence(['teams_list_chats'], [], false, true);
    expect(e.verdict).toBe('prose_only');
    expect(e.missing).toEqual(['teams_list_chats']);
    expect(e.returnedData).toBe(false);
  });

  it('distinguishes never-probed from probed-and-silent', () => {
    // Absence of a check is not a passed check, and the report must be able to say which.
    expect(classifyEvidence(['x'], [], false, false).verdict).toBe('not_probed');
    expect(classifyEvidence(['x'], [], false, true).verdict).toBe('prose_only');
  });

  it('tolerates cosmetic naming differences instead of reading them as a swap', () => {
    // The runtime prefixes names (default_api.jira_search). A prefix is not a different
    // tool, and treating it as one would report every healthy agent as serving the wrong
    // package.
    const e = classifyEvidence(['jira_search'], ['default_api.jira_search'], true, true);
    expect(e.verdict).toBe('tools_confirmed');
    expect(e.unexpected).toEqual([]);
  });

  it('does not claim a swap when nothing was expected', () => {
    // With no wired tools there is no "another agent's tools" to detect — an agent with no
    // connectors that calls a built-in has not been swapped.
    const e = classifyEvidence([], ['transfer_to_agent'], true, true);
    expect(e.verdict).toBe('tools_confirmed');
  });

  it('carries returnedData separately from called', () => {
    // A tool that ran and errored is not a tool that worked. Callers need both facts.
    const called = classifyEvidence(['get_deals'], ['get_deals'], false, true);
    expect(called.verdict).toBe('tools_confirmed');
    expect(called.returnedData).toBe(false);
  });
});
