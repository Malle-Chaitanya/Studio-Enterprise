import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The regressions these tests exist to prevent are all the same shape: verification
 * reporting a pass it did not earn.
 *
 * Every case below corresponds to something that actually shipped — an agent whose probe
 * endpoint 404'd, an agent that returned 200 with no text, an agent deployed with none of
 * its tools. Each one reported `verified` to a customer.
 *
 * The rule: a 200 is not an answer, and `deployed=true` is not `works=true`.
 */

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('./gemini.js', () => ({ assistantBase: () => 'https://de.example/v1alpha/engines/e/assistants/a' }));
vi.mock('./adkAgentChat.js', () => ({ chatWithAdkAgent: mocks.chat }));

const { verifyAgent } = await import('./verify.js');

const dest = { project: 'p', engine: 'e', assistant: 'a', location: 'global' } as never;

/** Agent resource exists — the level-1 check every test needs to get past. */
const existsOk = { ok: true, status: 200, json: async () => ({}) };

beforeEach(() => {
  mocks.chat.mockReset();
  mocks.fetch.mockReset();
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('existence check', () => {
  it('fails when the agent is not retrievable', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 404 });
    const r = await verifyAgent(dest, 'tok', 'a1');
    expect(r.status).toBe('failed');
    expect(r.verified).toBe(false);
  });

  it('reports unknown — not failed — when the network prevented the check', async () => {
    // A connection reset says nothing about the agent. Asserting either verdict is a guess.
    mocks.fetch.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    const r = await verifyAgent(dest, 'tok', 'a1');
    expect(r.status).toBe('unknown');
    expect(r.verified).toBe(false);
  });
});

describe('the low-code path must never claim a pass', () => {
  // These used to mock a 200 from `${assistantBase}:assist` and assert `verified`.
  // Measured against the live engine on 2026-08-24, that endpoint does not exist on any
  // API version -- v1alpha, v1beta and v1 all return 404 "Method not found" -- so the
  // mock was making an impossible call succeed and the suite was green over a path
  // production could never take. The real method is `:streamAssist`, and it CANNOT be
  // aimed at one agent: `agentsConfig.agent` is accepted and ignored, and a deliberately
  // bogus agent id returns the same answer as sending none (the engine's default
  // assistant introducing itself). So there is no per-agent probe to mock.
  it('returns unknown for a low-code agent, whatever the network does', async () => {
    mocks.fetch.mockResolvedValueOnce(existsOk);
    const r = await verifyAgent(dest, 'tok', 'a1');
    expect(r.status).toBe('unknown');
    expect(r.verified).toBe(false);
    expect(r.note).toContain('unproven');
  });

  it('names the real reason, not a transient failure', async () => {
    // "assist probe was unavailable (400)" read as an outage and was actually a call that
    // could never have worked. A reader must be able to tell "we could not reach it" from
    // "no such capability exists".
    mocks.fetch.mockResolvedValueOnce(existsOk);
    const r = await verifyAgent(dest, 'tok', 'a1');
    expect(r.note).toContain('no per-agent probe');
  });

  it('never probes after the existence check', async () => {
    // One call -- the existence GET. A second would mean something is still being asked
    // of an endpoint that cannot answer for this agent.
    mocks.fetch.mockResolvedValueOnce(existsOk);
    await verifyAgent(dest, 'tok', 'a1');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('still fails -- not unknown -- when the agent resource is gone', async () => {
    // The existence check is the one thing that CAN still fail definitively, and a
    // missing agent must not be softened into "unproven".
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const r = await verifyAgent(dest, 'tok', 'a1');
    expect(r.status).toBe('failed');
    expect(r.verified).toBe(false);
  });
});

describe('grounding evidence (ADK path)', () => {
  beforeEach(() => mocks.fetch.mockResolvedValue(existsOk));

  it('fails when the agent answers without ever retrieving', async () => {
    mocks.chat.mockResolvedValue({ ok: true, answer: 'I can help with lots of things!', toolCalled: false, toolSucceeded: false });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, { reasoningEngineId: 're1', expectsGrounding: true });
    expect(r.status).toBe('failed');
    expect(r.note).toContain('never called');
  });

  it('fails when a tool ran but returned an error', async () => {
    mocks.chat.mockResolvedValue({ ok: true, answer: 'Here is what I found.', toolCalled: true, toolError: 'PERMISSION_DENIED' });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, { reasoningEngineId: 're1', expectsGrounding: true });
    expect(r.status).toBe('failed');
    expect(r.note).toContain('retrieval failed');
  });

  it('verifies when a tool returned data', async () => {
    mocks.chat.mockResolvedValue({
      ok: true, answer: 'I can see "Q1 Report.pdf".',
      toolCalled: true, toolSucceeded: true, toolNames: ['search_knowledge'],
    });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, { reasoningEngineId: 're1', expectsGrounding: true });
    expect(r.status).toBe('verified');
    expect(r.toolsProven).toContain('search_knowledge');
  });
});

describe('tool inventory', () => {
  beforeEach(() => mocks.fetch.mockResolvedValue(existsOk));

  const answered = { ok: true, answer: 'I help with Jira.', toolCalled: false, toolSucceeded: false };

  it('fails when the deployment reports no tools at all', async () => {
    // The case that costs a customer everything: deploy succeeds, agent talks, zero tools.
    mocks.chat.mockResolvedValueOnce(answered).mockResolvedValueOnce({ ok: true, answer: 'NO TOOLS' });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, {
      reasoningEngineId: 're1', expectsTools: ['jira_list_issues', 'jira_get_issue'],
    });
    expect(r.status).toBe('failed');
    expect(r.toolsMissing).toEqual(['jira_list_issues', 'jira_get_issue']);
  });

  it('fails and names only the tools that are actually missing', async () => {
    mocks.chat.mockResolvedValueOnce(answered).mockResolvedValueOnce({ ok: true, answer: 'jira_list_issues' });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, {
      reasoningEngineId: 're1', expectsTools: ['jira_list_issues', 'jira_get_issue'],
    });
    expect(r.status).toBe('failed');
    expect(r.toolsMissing).toEqual(['jira_get_issue']);
  });

  it('verifies when every wired tool is reported', async () => {
    mocks.chat
      .mockResolvedValueOnce(answered)
      .mockResolvedValueOnce({ ok: true, answer: '- jira_list_issues\n- jira_get_issue' });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, {
      reasoningEngineId: 're1', expectsTools: ['jira_list_issues', 'jira_get_issue'],
    });
    expect(r.status).toBe('verified');
    expect(r.toolsMissing).toBeUndefined();
  });

  it('tolerates cosmetic formatting drift rather than crying wolf', async () => {
    // Matching is normalised: the model is describing its schema in prose, and punctuation
    // differences are not a missing tool.
    mocks.chat
      .mockResolvedValueOnce(answered)
      .mockResolvedValueOnce({ ok: true, answer: '1. `Jira List Issues`  2. `Jira-Get-Issue`' });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, {
      reasoningEngineId: 're1', expectsTools: ['jira_list_issues', 'jira_get_issue'],
    });
    expect(r.status).toBe('verified');
  });

  it('returns unknown — not verified — when the inventory answer is unreadable', async () => {
    mocks.chat.mockResolvedValueOnce(answered).mockResolvedValueOnce({ ok: false, error: 'timeout' });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, {
      reasoningEngineId: 're1', expectsTools: ['jira_list_issues'],
    });
    expect(r.status).toBe('unknown');
    expect(r.verified).toBe(false);
  });

  it('skips the inventory probe entirely when no tools were wired', async () => {
    mocks.chat.mockResolvedValueOnce({ ok: true, answer: 'Hello, I can help.' });
    const r = await verifyAgent(dest, 'tok', 'a1', undefined, { reasoningEngineId: 're1', expectsTools: [] });
    expect(r.status).toBe('verified');
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });
});

describe('verified is never true unless status is verified', () => {
  it('holds across every outcome', async () => {
    const cases: Array<() => void> = [
      () => mocks.fetch.mockResolvedValue({ ok: false, status: 500 }),
      () => mocks.fetch.mockResolvedValueOnce(existsOk).mockResolvedValueOnce({ ok: false, status: 404 }),
      () => mocks.fetch.mockResolvedValueOnce(existsOk).mockRejectedValueOnce(new Error('x')),
    ];
    for (const setup of cases) {
      mocks.fetch.mockReset();
      setup();
      const r = await verifyAgent(dest, 'tok', 'a1');
      expect(r.verified).toBe(r.status === 'verified');
      expect(r.verified).toBe(false);
    }
  });
});
