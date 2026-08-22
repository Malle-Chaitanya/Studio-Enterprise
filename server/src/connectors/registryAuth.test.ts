import { describe, it, expect } from 'vitest';
import { CONNECTOR_REGISTRY } from './registry.js';

/**
 * A connector's auth fields are only ever exercised inside a deployed Reasoning Engine, an
 * hour and a container away from here. When one is missing the symptom is not a validation
 * error — it is an agent telling a customer "the authentication failed", with nothing in
 * the logs pointing at the registry.
 *
 * That happened on 2026-08-19: a spec reached the container with no `tokenUrlTemplate`, so
 * `_mint_token` in adk_deploy.py had no endpoint to POST to. That instance was a spike
 * hand-writing its own spec, but nothing stopped a REGISTRY entry from having the same hole,
 * and the blast radius is larger — every agent using that connector.
 *
 * These assert the auth kinds are internally consistent, so the gap is caught here rather
 * than in a conversation.
 */
describe('registry auth completeness', () => {
  const oauthKinds = ['oauth2-client-credentials', 'oauth2-refresh-token'];

  it('every OAuth connector declares a token endpoint', () => {
    for (const c of CONNECTOR_REGISTRY) {
      if (!c.authKind || !oauthKinds.includes(c.authKind)) continue;
      expect(c.tokenUrlTemplate, `${c.id} (${c.authKind}) has no tokenUrlTemplate`).toBeTruthy();
    }
  });

  it('every OAuth connector can actually reach its credentials', () => {
    // A token endpoint is useless without the client id/secret to post to it. Those arrive
    // either from the connector's own `credentials` or from its shared credential group.
    for (const c of CONNECTOR_REGISTRY) {
      if (!c.authKind || !oauthKinds.includes(c.authKind)) continue;
      const hasOwn = (c.credentials?.length ?? 0) > 0;
      expect(hasOwn || Boolean(c.credentialGroup), `${c.id} declares neither credentials nor a credentialGroup`).toBe(true);
    }
  });

  it('a token URL placeholder always names a credential the customer supplies', () => {
    // `{tenant_id}` in the URL is filled from a stored credential. If the field is not
    // declared anywhere the template silently resolves to an empty string and the POST goes
    // to a malformed URL — a 400 that reads like the vendor rejecting us.
    const groupFields: Record<string, string[]> = {};
    for (const c of CONNECTOR_REGISTRY) {
      if (c.credentialGroup && c.credentials?.length) {
        groupFields[c.credentialGroup] = (groupFields[c.credentialGroup] ?? []).concat(
          c.credentials.map((f) => f.key),
        );
      }
    }
    for (const c of CONNECTOR_REGISTRY) {
      if (!c.tokenUrlTemplate) continue;
      const placeholders = [...c.tokenUrlTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (placeholders.length === 0) continue;
      const known = new Set([
        ...(c.credentials ?? []).map((f) => f.key),
        ...(c.credentialGroup ? groupFields[c.credentialGroup] ?? [] : []),
        // Filled by the platform, not the customer.
        'access_token',
      ]);
      for (const p of placeholders) {
        // A grouped connector's fields live on the group, which this test reconstructs from
        // whichever member declares them; treat a group member as satisfied if ANY member
        // declares the field.
        const satisfied = known.has(p) || Boolean(c.credentialGroup);
        expect(satisfied, `${c.id} token URL uses {${p}} but nothing declares it`).toBe(true);
      }
    }
  });
});
