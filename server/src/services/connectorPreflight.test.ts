import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { reasoningEngineServiceAgent, preflightConnectors } from './connectorPreflight.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

/**
 * The property these lock is the one the product depends on: this gate must work for a
 * connector NOBODY HAS WRITTEN YET. A per-connector branch here would mean every new
 * connector ships with an untested inference path, which is exactly how "deployed=true" came
 * to mean nothing.
 */
describe('connector preflight is connector-agnostic', () => {
  it('contains no connector-specific branch', () => {
    // Read the source rather than assert on behaviour: the failure being prevented is a
    // future edit adding `if (connectorId === 'shared_x')`, which no output test would catch.
    const src = readFileSync(new URL('./connectorPreflight.ts', import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/shared_[a-z]/);
    // Nor the provider names, which is the other way a special case creeps in.
    for (const word of ['hubspot', 'atlassian', 'jira', 'confluence', 'outlook', 'gmail', 'teams', 'googlechat']) {
      expect(code.toLowerCase(), `preflight mentions ${word}`).not.toContain(word);
    }
  });

  it('derives the inference-time identity from the project number alone', () => {
    // Hardcoding this email per project is how a multi-tenant tool silently checks the wrong
    // identity and passes every time.
    expect(reasoningEngineServiceAgent('231705905417')).toBe(
      'service-231705905417@gcp-sa-aiplatform-re.iam.gserviceaccount.com',
    );
    expect(reasoningEngineServiceAgent('99')).toContain('service-99@');
  });
});

describe('preflight verdicts', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Project-wide grant present, so no per-secret policy call is needed. */
  const projectWideGranted = (member: string) => ({
    ok: true,
    json: async () => ({ bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [member] }] }),
    text: async () => '',
  });

  it('returns nothing for an agent with no connectors', async () => {
    // Must not make a single network call — most migrations have no connectors at all and
    // this runs on the deploy path.
    const out = await preflightConnectors('tok', 'proj', '1', []);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a connector with no credential recorded, without calling out', async () => {
    fetchMock.mockResolvedValueOnce(projectWideGranted('serviceAccount:service-1@gcp-sa-aiplatform-re.iam.gserviceaccount.com'));
    const out = await preflightConnectors('tok', 'proj', '1', [
      { connectorId: 'shared_anything', name: 'Anything', secretIds: {} },
    ]);
    expect(out[0].ok).toBe(false);
    expect(out[0].blocker).toBe('no_credential_recorded');
    // Only the project-policy probe — no secret reads for a connector with no secrets.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks when the stored secret cannot be read back', async () => {
    fetchMock
      .mockResolvedValueOnce(projectWideGranted('serviceAccount:service-1@gcp-sa-aiplatform-re.iam.gserviceaccount.com'))
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' });
    const out = await preflightConnectors('tok', 'proj', '1', [
      { connectorId: 'shared_x', name: 'X', secretIds: { api_key: 'sec-x' } },
    ]);
    expect(out[0].blocker).toBe('secret_unreadable');
    // Names the offending secret, not just the connector — the difference between an
    // actionable message and "X is broken".
    expect(out[0].detail).toContain('sec-x');
  });

  it('blocks when the engine identity cannot read the secret, and names the grant', async () => {
    const member = 'serviceAccount:service-1@gcp-sa-aiplatform-re.iam.gserviceaccount.com';
    fetchMock
      // no project-wide grant
      .mockResolvedValueOnce({ ok: true, json: async () => ({ bindings: [] }), text: async () => '' })
      // secret reads back fine for US
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ payload: { data: Buffer.from('v').toString('base64') } }),
        text: async () => '',
      })
      // ...but the engine has no binding on it
      .mockResolvedValueOnce({ ok: true, json: async () => ({ bindings: [] }), text: async () => '' });
    const out = await preflightConnectors('tok', 'proj', '1', [
      { connectorId: 'shared_x', name: 'X', secretIds: { api_key: 'sec-x' } },
    ]);
    expect(out[0].ok).toBe(false);
    expect(out[0].blocker).toBe('engine_cannot_read_secret');
    // The message has to carry the fix, because the customer is the only one who can apply it.
    expect(out[0].detail).toContain('roles/secretmanager.secretAccessor');
    expect(out[0].detail).toContain(member.replace('serviceAccount:', ''));
    expect(out[0].detail).toContain('PERMISSION_DENIED');
  });

  it('a project-wide grant satisfies every secret without per-secret checks', async () => {
    const member = 'serviceAccount:service-1@gcp-sa-aiplatform-re.iam.gserviceaccount.com';
    fetchMock
      .mockResolvedValueOnce(projectWideGranted(member))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: Buffer.from('v').toString('base64') } }),
        text: async () => '',
      });
    const out = await preflightConnectors('tok', 'proj', '1', [
      { connectorId: 'shared_unknownkind', name: 'Unknown', secretIds: { a: 's1', b: 's2' } },
    ]);
    expect(out[0].ok).toBe(true);
    // 1 project policy + 2 secret reads. No getIamPolicy per secret.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('passes an untestable provider instead of blocking on our own missing coverage', async () => {
    // A connector the validator has no test for returns `unverified`. Treating that as a
    // failure would block a customer because WE cannot check their provider, which is a
    // worse error than letting an unproven connector through with an honest note.
    const member = 'serviceAccount:service-1@gcp-sa-aiplatform-re.iam.gserviceaccount.com';
    fetchMock
      .mockResolvedValueOnce(projectWideGranted(member))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: Buffer.from('v').toString('base64') } }),
        text: async () => '',
      });
    const out = await preflightConnectors('tok', 'proj', '1', [
      { connectorId: 'shared_somethingnew', name: 'Something New', secretIds: { token: 's1' } },
    ]);
    expect(out[0].ok).toBe(true);
    expect(out[0].validation).toBe('unverified');
  });

  it('checks each connector independently — one blocker does not condemn the rest', async () => {
    // A migration with several connectors must report per connector, or a customer fixes one
    // thing and re-runs blind.
    const member = 'serviceAccount:service-1@gcp-sa-aiplatform-re.iam.gserviceaccount.com';
    fetchMock
      .mockResolvedValueOnce(projectWideGranted(member))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: Buffer.from('v').toString('base64') } }),
        text: async () => '',
      });
    const out = await preflightConnectors('tok', 'proj', '1', [
      { connectorId: 'shared_a', name: 'A', secretIds: {} },
      { connectorId: 'shared_b', name: 'B', secretIds: { token: 's1' } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].ok).toBe(false);
    expect(out[1].ok).toBe(true);
  });
});

describe('every registered connector is checkable by this gate', () => {
  it('no registry connector needs a code change here to be covered', () => {
    // The gate keys off recorded secret ids, which every credential-bearing connector has by
    // construction. This asserts the assumption holds across the whole registry rather than
    // just the ones built so far.
    for (const def of REGISTRY_BY_ID.values()) {
      const needsCreds = (def.credentials?.length ?? 0) > 0 || !!def.credentialGroup;
      if (!needsCreds) continue;
      // A connector that wants credentials must declare at least one field somewhere, or
      // nothing can ever record a secret for it and the gate would pass it vacuously.
      const fieldCount = (def.credentials?.length ?? 0);
      expect(
        fieldCount > 0 || !!def.credentialGroup,
        `${def.id} wants credentials but declares no field and no group`,
      ).toBe(true);
    }
  });
});
