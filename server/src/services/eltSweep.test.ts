import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The ELT sweep's contract is mostly about what it must NOT do.
 *
 * It runs off the back of a customer connect, so the failure that matters is not "the sweep
 * was wrong" — it is "the sweep took something else down with it". These tests drive the
 * failure paths, not the happy one.
 */

const listBots = vi.fn();
const extractAgent = vi.fn();
const saveRawAgent = vi.fn();
const cacheExtractedIR = vi.fn();
const clientCredsToken = vi.fn();
const discoverEnvironments = vi.fn();
const graphTokenFromRefresh = vi.fn();
const listGraphUsersFiltered = vi.fn();
const saveSourceUsers = vi.fn();

vi.mock('../services/dataverse.js', () => ({
  listBots: (...a: unknown[]) => listBots(...a),
  extractAgent: (...a: unknown[]) => extractAgent(...a),
}));
vi.mock('../auth/microsoft.js', () => ({
  clientCredsToken: (...a: unknown[]) => clientCredsToken(...a),
  discoverEnvironments: (...a: unknown[]) => discoverEnvironments(...a),
  graphTokenFromRefresh: (...a: unknown[]) => graphTokenFromRefresh(...a),
  listGraphUsersFiltered: (...a: unknown[]) => listGraphUsersFiltered(...a),
}));
vi.mock('../db/repos/rawAgents.js', () => ({
  saveRawAgent: (...a: unknown[]) => saveRawAgent(...a),
  rawRetentionDays: () => 90,
  rawAgentStats: async () => ({ total: 0, neverExpires: 0 }),
}));
vi.mock('../db/repos/agentIR.js', () => ({
  cacheExtractedIR: (...a: unknown[]) => cacheExtractedIR(...a),
}));
vi.mock('../db/repos/eltSweeps.js', () => ({
  saveSweepResult: async () => undefined,
  getSweepResult: async () => null,
}));
vi.mock('../db/repos/sourceUsers.js', () => ({
  saveSourceUsers: (...a: unknown[]) => saveSourceUsers(...a),
}));

const { runEltSweep } = await import('./eltSweep.js');

beforeEach(() => {
  vi.clearAllMocks();
  clientCredsToken.mockResolvedValue('tok');
  discoverEnvironments.mockResolvedValue([]);
  listBots.mockResolvedValue([]);
  graphTokenFromRefresh.mockResolvedValue('graph-tok');
  listGraphUsersFiltered.mockResolvedValue({ users: [], stats: {} });
});

const bot = (id: string) => ({ botid: id, name: `agent-${id}` });

describe('the sweep never lets one failure become another', () => {
  it('reports an unreachable environment instead of dropping it from the list', async () => {
    discoverEnvironments.mockResolvedValue([
      { url: 'https://a.crm', name: 'A', id: '1' },
      { url: 'https://b.crm', name: 'B', id: '2' },
    ]);
    clientCredsToken.mockImplementation(async (_t: string, url: string) => {
      if (url === 'https://a.crm') throw new Error('403 forbidden');
      return 'tok';
    });
    listBots.mockResolvedValue([bot('x')]);
    extractAgent.mockResolvedValue({ sourceId: 'x' });

    const r = await runEltSweep('u1', 'tenant');

    // A short list that looks complete is the failure mode. The bad environment must still
    // appear, carrying its reason.
    expect(r.environments).toHaveLength(2);
    const bad = r.environments.find((e) => e.envUrl === 'https://a.crm');
    expect(bad?.error).toContain('403');
    expect(bad?.landed).toBe(0);
    // ...and the healthy one is unaffected.
    expect(r.environments.find((e) => e.envUrl === 'https://b.crm')?.landed).toBe(1);
  });

  it('keeps going when one agent fails to parse, and still counts it', async () => {
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('ok1'), bot('bad'), bot('ok2')]);
    extractAgent.mockImplementation(async (_u: string, _t: string, b: { botid: string }) => {
      if (b.botid === 'bad') throw new Error('unparseable component');
      return { sourceId: b.botid };
    });

    const r = await runEltSweep('u2', 'tenant');

    expect(r.totalLanded).toBe(2);
    expect(r.totalFailed).toBe(1);
    expect(r.totalAgents).toBe(3);
  });

  it('lands the raw payload unconditionally, not behind the retention flag', async () => {
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('x')]);
    extractAgent.mockImplementation(async (_u: string, _t: string, b: { botid: string }, onRaw: (r: unknown) => void) => {
      onRaw({ envUrl: 'https://a.crm', sourceId: b.botid, sourceName: 'n', components: [] });
      return { sourceId: b.botid };
    });

    await runEltSweep('u3', 'tenant');

    // `always: true` IS the ELT contract — raw is the source the transform reads from, so a
    // config value nobody set must not silently empty it.
    expect(saveRawAgent).toHaveBeenCalledWith(expect.objectContaining({ always: true }));
  });

  it('writes every sweep under the SAME row key, so a re-sweep replaces instead of duplicating', async () => {
    // The bug this exists to prevent: a row key derived from the clock means sweep N+1 never
    // replaces sweep N, so each sweep adds a complete second copy of every unredacted
    // payload — unbounded, since at RAW_RETENTION_DAYS=0 nothing expires. Caught only by
    // sweeping TWICE, which the original tests never did.
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('x')]);
    extractAgent.mockImplementation(async (_u: string, _t: string, b: { botid: string }, onRaw: (r: unknown) => void) => {
      onRaw({ envUrl: 'https://a.crm', sourceId: b.botid, sourceName: 'n', components: [] });
      return { sourceId: b.botid };
    });

    const first = await runEltSweep('u7', 'tenant');
    const second = await runEltSweep('u7', 'tenant');

    const keys = saveRawAgent.mock.calls.map((c) => (c[0] as { runId: string }).runId);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);

    // The sweeps are still distinguishable in the RESULT — it is only the storage key that
    // must stay constant.
    expect(first.sweepId).not.toBe(second.sweepId);
  });

  it('keeps the sweep row key out of the run-id namespace', async () => {
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('x')]);
    extractAgent.mockImplementation(async (_u: string, _t: string, b: { botid: string }, onRaw: (r: unknown) => void) => {
      onRaw({ envUrl: 'https://a.crm', sourceId: b.botid, sourceName: 'n', components: [] });
      return { sourceId: b.botid };
    });

    const r = await runEltSweep('u4', 'tenant');

    expect(r.sweepId).toMatch(/^sweep:/);
    // A constant, and NOT the timestamped sweep id — a real migration runId is a uuid, so
    // 'elt-sweep' cannot collide with one.
    expect(saveRawAgent).toHaveBeenCalledWith(expect.objectContaining({ runId: 'elt-sweep' }));
  });

  it('NAMES the agents it missed, not just how many', async () => {
    // A count is not actionable, and here it is misleading: everything downstream reads
    // Mongo, so an agent that never landed is a hole in the source rather than a step
    // someone will see fail again later.
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('good'), bot('bad')]);
    extractAgent.mockImplementation(async (_u: string, _t: string, b: { botid: string }) => {
      if (b.botid === 'bad') throw new Error('Dataverse GET botcomponents failed (429)');
      return { sourceId: b.botid };
    });

    const r = await runEltSweep('u8', 'tenant');
    const env = r.environments[0];

    expect(env.failures).toHaveLength(1);
    expect(env.failures?.[0]).toMatchObject({ sourceId: 'bad', name: 'agent-bad' });
    expect(env.failures?.[0].reason).toContain('429');
  });

  it('survives environment discovery failing entirely', async () => {
    discoverEnvironments.mockRejectedValue(new Error('BAP down'));

    // The connect that triggered this must not fail. An empty sweep is the correct answer.
    const r = await runEltSweep('u5', 'tenant');

    expect(r.environments).toEqual([]);
    expect(r.totalAgents).toBe(0);
  });
});

describe('one tenant, one sweep', () => {
  it('joins an in-flight sweep rather than starting a second', async () => {
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('x')]);
    // The gate is built BEFORE the sweep starts. Assigning it inside the mock would mean
    // releasing it before `extractAgent` had ever been called, which is a hang, not a test.
    let release: () => void = () => undefined;
    const gate = new Promise((res) => { release = () => res({ sourceId: 'x' }); });
    extractAgent.mockReturnValue(gate);

    const first = runEltSweep('u6', 'tenant');
    const second = runEltSweep('u6', 'tenant');
    release();
    const [a, b] = await Promise.all([first, second]);

    // Two concurrent sweeps would double the customer's quota spend to produce identical
    // rows, so the second call must be the same promise, not a race.
    expect(a).toBe(b);
    expect(discoverEnvironments).toHaveBeenCalledTimes(1);
  });

  it('does NOT let a second tenant under one operator join the first tenant sweep', async () => {
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('x')]);
    let release: () => void = () => undefined;
    const gate = new Promise((res) => { release = () => res({ sourceId: 'x' }); });
    extractAgent.mockReturnValue(gate);

    // Same operator, two connected customer tenants. De-duplication is meant to stop the
    // SAME work running twice — keyed on appUserId alone it stopped tenant B running AT
    // ALL, handed back tenant A's result, and said nothing.
    const a = runEltSweep('u7', 'tenant-a');
    const b = runEltSweep('u7', 'tenant-b');
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).not.toBe(rb);
    expect(ra.tenantId).toBe('tenant-a');
    expect(rb.tenantId).toBe('tenant-b');
    expect(discoverEnvironments).toHaveBeenCalledTimes(2);
  });
});

describe('the source-user snapshot', () => {
  it('is taken when a refresh token is supplied', async () => {
    listGraphUsersFiltered.mockResolvedValue({
      users: [{ id: '1', email: 'a@x.com', displayName: 'A' }],
      stats: { returned: 1 },
    });

    await runEltSweep('u9', 'tenant', 'refresh-token');

    expect(saveSourceUsers).toHaveBeenCalledWith('u9', 'tenant', expect.objectContaining({
      users: [expect.objectContaining({ email: 'a@x.com' })],
    }));
  });

  it('is SKIPPED without a refresh token, and the agent sweep still runs', async () => {
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('x')]);
    extractAgent.mockResolvedValue({ sourceId: 'x' });

    const r = await runEltSweep('u10', 'tenant');

    expect(saveSourceUsers).not.toHaveBeenCalled();
    // The point: no token degrades ONE part of the sweep, it does not fail the sweep.
    expect(r.totalLanded).toBe(1);
  });

  it('a failed snapshot does not fail the sweep — Map users just reads Graph live', async () => {
    discoverEnvironments.mockResolvedValue([{ url: 'https://a.crm', name: 'A', id: '1' }]);
    listBots.mockResolvedValue([bot('x')]);
    extractAgent.mockResolvedValue({ sourceId: 'x' });
    listGraphUsersFiltered.mockRejectedValue(new Error('Graph 503'));

    const r = await runEltSweep('u11', 'tenant', 'refresh-token');

    expect(r.totalLanded).toBe(1);
    expect(saveSourceUsers).not.toHaveBeenCalled();
  });
});
