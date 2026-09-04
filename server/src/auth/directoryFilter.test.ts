import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Directory listings feed the Map Users grid, where every row is offered as a mapping
 * target. A disabled or unlicensed account accepted there produces a mapping that fails
 * much later — during a share or a grant — where it reads as a migration bug rather than
 * as "that person has no licence".
 *
 * The rule these tests exist to protect is the SECOND one, not the first: filtering must
 * never be applied on a signal we failed to read. An unreadable licence field is not
 * evidence of an unlicensed tenant, and treating it as one empties the grid and blames the
 * customer's licensing for our own failed read. That failure looks identical to a correct
 * empty result, which is what makes it worth a test rather than a comment.
 */

/**
 * These tests re-import `google.js` after `vi.resetModules()`, because that module reads
 * DIRECTORY_ACTIVE_ONLY at load time and the env has to be stubbed first. That is a COLD
 * import of a large module (it pulls in google-auth-library), so the work is genuinely
 * slow — around a second idle, and well past vitest's 5s default when 42 test files are
 * competing for the same machine.
 *
 * This produced an intermittent failure that passed 51 runs out of 52 and cost a full
 * investigation to identify, because a timeout reads exactly like a flaky assertion. The
 * timeout is raised rather than the import removed: the module genuinely must be reloaded
 * per env, and pretending otherwise would trade a visible flake for a silent one.
 */
vi.setConfig({ testTimeout: 30_000 });

const ORIGINAL_FETCH = globalThis.fetch;

/** One Graph page, shaped like the real payload. */
function graphPage(users: unknown[], nextLink?: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ value: users, ...(nextLink ? { '@odata.nextLink': nextLink } : {}) }),
    text: async () => '',
  } as unknown as Response;
}

const user = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'id-' + (over.mail ?? over.userPrincipalName ?? 'x'),
  displayName: 'A User',
  mail: 'a@filefuze.co',
  accountEnabled: true,
  userType: 'Member',
  assignedPlans: [{ service: 'exchange', capabilityStatus: 'Enabled' }],
  ...over,
});

describe('Graph directory filtering', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.unstubAllEnvs();
  });

  async function listWith(users: unknown[], env: Record<string, string> = {}) {
    // Pin every setting this module reads. config.ts loads the developer's own .env, so
    // without this a test asserts against whatever that machine happens to have configured
    // — setting MS_REQUIRED_SERVICE_PLANS locally broke four of these, and CI (which has no
    // .env) would have disagreed with a laptop about whether the code works.
    vi.stubEnv('MS_REQUIRED_SERVICE_PLANS', '');
    vi.stubEnv('DIRECTORY_ACTIVE_ONLY', 'true');
    vi.stubEnv('DIRECTORY_LICENSED_ONLY', 'true');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    globalThis.fetch = vi.fn(async () => graphPage(users)) as unknown as typeof fetch;
    const { listGraphUsersFiltered } = await import('./microsoft.js');
    return listGraphUsersFiltered('tok', { max: 50 });
  }

  it('drops a disabled account', async () => {
    const r = await listWith([
      user({ mail: 'live@filefuze.co' }),
      user({ mail: 'gone@filefuze.co', accountEnabled: false }),
    ]);
    expect(r.users.map((u) => u.email)).toEqual(['live@filefuze.co']);
    expect(r.stats.excludedInactive).toBe(1);
  });

  it('drops a guest identity', async () => {
    // A guest belongs to another tenant and cannot own a Copilot agent here, so offering
    // one as a mapping target produces a mapping that can never resolve.
    const r = await listWith([
      user({ mail: 'staff@filefuze.co' }),
      user({ mail: 'guest@partner.com', userType: 'Guest' }),
    ]);
    expect(r.users.map((u) => u.email)).toEqual(['staff@filefuze.co']);
    expect(r.stats.excludedGuest).toBe(1);
  });

  it('drops an account with no enabled service plan', async () => {
    const r = await listWith([
      user({ mail: 'licensed@filefuze.co' }),
      user({ mail: 'none@filefuze.co', assignedPlans: [] }),
      // A plan that exists but is switched off is not a licence.
      user({
        mail: 'disabled-plan@filefuze.co',
        assignedPlans: [{ service: 'exchange', capabilityStatus: 'Deleted' }],
      }),
    ]);
    expect(r.users.map((u) => u.email)).toEqual(['licensed@filefuze.co']);
    expect(r.stats.excludedUnlicensed).toBe(2);
    expect(r.stats.licenceCheck).toBe('applied');
  });

  it('SKIPS licence filtering when the field never arrived, and says so', async () => {
    // assignedPlans absent on every row means the directory read did not include it — a
    // scope problem on our side. Filtering here would return zero users and present that
    // as "nobody in this tenant is licensed".
    const r = await listWith([
      { id: '1', mail: 'a@filefuze.co', accountEnabled: true, userType: 'Member' },
      { id: '2', mail: 'b@filefuze.co', accountEnabled: true, userType: 'Member' },
    ]);
    expect(r.users).toHaveLength(2);
    expect(r.stats.licenceCheck).toBe('unavailable');
    expect(r.stats.excludedUnlicensed, 'nothing was filtered, so nothing may be counted').toBe(0);
  });

  it('narrows to a named service plan when one is configured', async () => {
    const r = await listWith(
      [
        user({
          mail: 'copilot@filefuze.co',
          assignedPlans: [{ service: 'POWER_VIRTUAL_AGENTS_365', capabilityStatus: 'Enabled' }],
        }),
        user({
          mail: 'mailonly@filefuze.co',
          assignedPlans: [{ service: 'exchange', capabilityStatus: 'Enabled' }],
        }),
      ],
      { MS_REQUIRED_SERVICE_PLANS: 'POWER_VIRTUAL_AGENTS' },
    );
    expect(r.users.map((u) => u.email)).toEqual(['copilot@filefuze.co']);
    expect(r.stats.requiredPlans).toEqual(['POWER_VIRTUAL_AGENTS']);
  });

  it('counts an account with no resolvable address in its own bucket', async () => {
    // Not a filter decision — there is nothing to map such an account BY. It gets its own
    // count so `returned + excluded` closes; without it every other number on the screen
    // looks approximate, and the copy has to hedge with "at least".
    const r = await listWith([
      user({ mail: 'ok@filefuze.co' }),
      { id: 'x', displayName: 'No Address', accountEnabled: true, userType: 'Member' },
    ]);
    expect(r.users.map((u) => u.email)).toEqual(['ok@filefuze.co']);
    expect(r.stats.excludedNoAddress).toBe(1);
    expect(r.stats.excludedUnlicensed, 'a missing address is not a licence verdict').toBe(0);
  });

  it('returns everything when both filters are off', async () => {
    // The escape hatch behind `?all=1`. An admin asking "why is this person missing" needs
    // to see the disabled account to get their answer.
    vi.stubEnv('MS_REQUIRED_SERVICE_PLANS', '');
    globalThis.fetch = vi.fn(async () =>
      graphPage([
        user({ mail: 'live@filefuze.co' }),
        user({ mail: 'gone@filefuze.co', accountEnabled: false }),
        user({ mail: 'none@filefuze.co', assignedPlans: [] }),
      ]),
    ) as unknown as typeof fetch;
    const { listGraphUsersFiltered } = await import('./microsoft.js');
    const r = await listGraphUsersFiltered('tok', { max: 50, activeOnly: false, licensedOnly: false });
    expect(r.users).toHaveLength(3);
    expect(r.stats.excludedInactive).toBe(0);
    expect(r.stats.excludedUnlicensed).toBe(0);
  });

  it('escapes a quote in the search term instead of deleting it', async () => {
    // Stripping the apostrophe searches for something the user did not type: O'Brien
    // becomes OBrien and matches nobody, which reads as "that person is not in the
    // directory". OData escapes a quote by doubling it.
    vi.stubEnv('MS_REQUIRED_SERVICE_PLANS', '');
    let seen = '';
    globalThis.fetch = vi.fn(async (u: unknown) => {
      seen = String(u);
      return graphPage([]);
    }) as unknown as typeof fetch;
    const { listGraphUsersFiltered } = await import('./microsoft.js');
    await listGraphUsersFiltered('tok', { max: 10, query: "O'Brien" });
    expect(decodeURIComponent(seen)).toContain("O''Brien");
  });

  it('asks Graph to exclude disabled accounts server-side', async () => {
    vi.stubEnv('MS_REQUIRED_SERVICE_PLANS', '');
    let seen = '';
    globalThis.fetch = vi.fn(async (u: unknown) => {
      seen = String(u);
      return graphPage([]);
    }) as unknown as typeof fetch;
    const { listGraphUsersFiltered } = await import('./microsoft.js');
    await listGraphUsersFiltered('tok', { max: 10 });
    expect(decodeURIComponent(seen)).toContain('accountEnabled eq true');
  });
});

describe('Workspace directory filtering', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.unstubAllEnvs();
  });

  it('drops suspended, archived and pending-deletion accounts', async () => {
    vi.stubEnv('DIRECTORY_ACTIVE_ONLY', 'true');
    // All three still appear in the Directory API. Each one accepted as a mapping target
    // fails later at share/grant time.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        users: [
          { primaryEmail: 'live@filefuze.co', name: { fullName: 'Live' } },
          { primaryEmail: 'susp@filefuze.co', suspended: true },
          { primaryEmail: 'arch@filefuze.co', archived: true },
          { primaryEmail: 'dele@filefuze.co', deletionTime: '2026-09-01T00:00:00Z' },
        ],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const { listWorkspaceUsersFiltered } = await import('./google.js');
    const r = await listWorkspaceUsersFiltered('tok', { max: 50 });
    expect(r.users.map((u) => u.email)).toEqual(['live@filefuze.co']);
    expect(r.excludedInactive).toBe(3);
  });
});
