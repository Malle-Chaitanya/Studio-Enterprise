import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * These tests guard the three properties that make landing unredacted customer payloads
 * acceptable at all. Each one, if it regressed, would be invisible in a passing migration:
 *
 *   1. OFF unless opted in — a default that captured would leak customer data silently.
 *   2. NEVER throws — a diagnostic that can fail an extraction is worse than no diagnostic.
 *   3. TENANT-SCOPED and TTL-stamped — a row without `appUserId` is a cross-tenant read
 *      waiting to happen, and one without `expiresAt` outlives its retention window forever.
 */

const mocks = vi.hoisted(() => ({
  retentionDays: 0,
  connected: true,
  replaceOne: vi.fn(),
  find: vi.fn(),
  findOne: vi.fn(),
  countDocuments: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  get config() {
    return { RAW_RETENTION_DAYS: mocks.retentionDays };
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../core.js', () => ({
  isDbConnected: () => mocks.connected,
  getDb: () => ({
    collection: () => ({
      replaceOne: mocks.replaceOne,
      find: mocks.find,
      findOne: mocks.findOne,
      countDocuments: mocks.countDocuments,
      deleteMany: mocks.deleteMany,
    }),
  }),
}));

const {
  saveRawAgent, listRawAgents, getRawAgent, rawLandingEnabled, rawRetentionDays, rawAgentStats,
  purgeRawAgents,
} = await import('./rawAgents.js');

const args = {
  appUserId: 'user-1',
  runId: 'run-1',
  envUrl: 'https://org.crm.dynamics.com',
  sourceId: 'bot-1',
  sourceName: 'Knowledge Nexus',
  components: [{ name: 'topic-a', componenttype: 0 }],
};

beforeEach(() => {
  mocks.retentionDays = 0;
  mocks.connected = true;
  mocks.replaceOne.mockReset().mockResolvedValue({ acknowledged: true });
  mocks.find.mockReset().mockReturnValue({ toArray: async () => [] });
  mocks.findOne.mockReset().mockResolvedValue(null);
  mocks.countDocuments.mockReset().mockResolvedValue(0);
  mocks.deleteMany.mockReset().mockResolvedValue({ deletedCount: 3 });
});

describe('a purge deletes one customer, and admits what it left', () => {
  it('deletes only the named tenant, never the operator whole', async () => {
    const r = await purgeRawAgents('user-1', 'tenant-a');
    // Deleting by operator would take a SECOND customer's payloads as collateral for a
    // purge someone ran against the first.
    expect(mocks.deleteMany).toHaveBeenCalledWith({ appUserId: 'user-1', tenantId: 'tenant-a' });
    expect(r.deleted).toBe(3);
  });

  it('leaves rows with no tenant alone and REPORTS them, rather than deleting or hiding them', async () => {
    mocks.countDocuments.mockResolvedValue(7);
    const r = await purgeRawAgents('user-1', 'tenant-a');
    // A row landed before tenants were recorded could belong to any connected customer.
    // Silently deleting it risks another customer's data; silently ignoring it reports a
    // completed purge that was not complete.
    expect(r.untagged).toBe(7);
    expect(mocks.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: { $exists: false } }),
    );
  });

  it('purges the whole operator when no tenant is known, and claims no untagged remainder', async () => {
    mocks.countDocuments.mockResolvedValue(7);
    const r = await purgeRawAgents('user-1');
    expect(mocks.deleteMany).toHaveBeenCalledWith({ appUserId: 'user-1' });
    expect(r.untagged).toBe(0);
  });

  it('refuses rather than reporting a deletion it never attempted', async () => {
    mocks.connected = false;
    await expect(purgeRawAgents('user-1', 'tenant-a')).rejects.toThrow(/not connected/);
  });
});

describe('held-payload counts name one customer, not one operator', () => {
  it('counts only the given tenant when one is named', async () => {
    await rawAgentStats('user-1', 'tenant-a');
    // One operator may have several customers connected. Counting by operator put another
    // customer's held payloads on this customer's status line.
    expect(mocks.countDocuments).toHaveBeenCalledWith({ appUserId: 'user-1', tenantId: 'tenant-a' });
    expect(mocks.countDocuments).toHaveBeenCalledWith(
      { appUserId: 'user-1', tenantId: 'tenant-a', expiresAt: { $exists: false } },
    );
  });

  it('falls back to the whole operator when no tenant is known, rather than counting nothing', async () => {
    await rawAgentStats('user-1');
    expect(mocks.countDocuments).toHaveBeenCalledWith({ appUserId: 'user-1' });
  });
});

afterEach(() => vi.clearAllMocks());

describe('opt-in gate', () => {
  it('writes NOTHING when RAW_RETENTION_DAYS is 0 (the default)', async () => {
    await saveRawAgent(args);
    expect(mocks.replaceOne).not.toHaveBeenCalled();
    expect(rawLandingEnabled()).toBe(false);
  });

  it('writes once the operator opts in', async () => {
    mocks.retentionDays = 7;
    await saveRawAgent(args);
    expect(mocks.replaceOne).toHaveBeenCalledTimes(1);
    expect(rawLandingEnabled()).toBe(true);
    expect(rawRetentionDays()).toBe(7);
  });

  it('writes nothing when Mongo is down, even if opted in', async () => {
    mocks.retentionDays = 7;
    mocks.connected = false;
    await saveRawAgent(args);
    expect(mocks.replaceOne).not.toHaveBeenCalled();
  });
});

describe('best-effort: a diagnostic must never fail an extraction', () => {
  it('swallows a write error instead of rejecting', async () => {
    mocks.retentionDays = 7;
    mocks.replaceOne.mockRejectedValue(new Error('mongo exploded'));
    await expect(saveRawAgent(args)).resolves.toBeUndefined();
  });

  it('returns an empty list rather than throwing when a read fails', async () => {
    mocks.find.mockImplementation(() => {
      throw new Error('read failed');
    });
    await expect(listRawAgents('user-1', 'run-1')).resolves.toEqual([]);
  });

  it('returns null rather than throwing when a single read fails', async () => {
    mocks.findOne.mockRejectedValue(new Error('read failed'));
    await expect(getRawAgent('user-1', 'run-1', 'bot-1')).resolves.toBeNull();
  });
});

describe('the written row', () => {
  it('is tenant-scoped, TTL-stamped, and keyed for idempotent re-runs', async () => {
    mocks.retentionDays = 7;
    const before = Date.now();
    await saveRawAgent(args);

    const [filter, doc] = mocks.replaceOne.mock.calls[0];

    // Re-running the same run must replace, not accumulate.
    expect(filter).toEqual({ appUserId: 'user-1', runId: 'run-1', sourceId: 'bot-1' });

    expect(doc.appUserId).toBe('user-1');
    expect(doc.components).toEqual(args.components);
    expect(doc.totalComponents).toBe(1);
    expect(doc.truncated).toBeUndefined();

    // Without expiresAt the TTL index has nothing to act on and the row is immortal.
    const ttlMs = doc.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(6.9 * 86_400_000);
    expect(ttlMs).toBeLessThan(7.1 * 86_400_000);
  });

  it('flags truncation rather than silently shrinking an oversized payload', async () => {
    mocks.retentionDays = 7;
    // ~1 MB per component, 12 components — over the 8 MB cap.
    const fat = Array.from({ length: 12 }, (_, i) => ({ i, blob: 'x'.repeat(1_000_000) }));
    await saveRawAgent({ ...args, components: fat });

    const doc = mocks.replaceOne.mock.calls[0][1];
    expect(doc.truncated).toBe(true);
    expect(doc.totalComponents).toBe(12);
    expect(doc.keptComponents).toBeLessThan(12);
    // A truncated payload that did not say so would read as "the field isn't there"
    // to a later blind-spot diff — the exact wrong conclusion.
    expect(doc.keptComponents).toBe(doc.components.length);
  });
});

describe('reads are tenant-scoped', () => {
  it('filters by appUserId on list', async () => {
    await listRawAgents('user-1', 'run-1');
    expect(mocks.find).toHaveBeenCalledWith({ appUserId: 'user-1', runId: 'run-1' });
  });

  it('filters by appUserId on get', async () => {
    await getRawAgent('user-1', 'run-1', 'bot-1');
    expect(mocks.findOne).toHaveBeenCalledWith({
      appUserId: 'user-1',
      runId: 'run-1',
      sourceId: 'bot-1',
    });
  });
});
