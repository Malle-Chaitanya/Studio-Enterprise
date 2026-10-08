import { describe, it, expect } from 'vitest';
import { requiredVendorScopes, scopeGaps } from './vendorScopeRequirements.js';
import type { ConnectorOpIndex } from '../connectors/operationBinding.js';

/**
 * The scope list must come from the CONNECTORS, not from a constant someone maintains.
 * The bug this prevents is specific and already happened: shared_googletasks bound five
 * operations while nothing requested the tasks scope, so the tools would have deployed and
 * failed to authenticate. A derived list cannot drift from the connectors in that way.
 */

function idx(connectorId: string, auth: ConnectorOpIndex['connectionAuth']): ConnectorOpIndex {
  return {
    connectorId, displayName: connectorId, proxyHost: '', proxyBasePath: '',
    securityDefinitions: {}, connectionAuth: auth, operationCount: 0, operations: {},
  };
}
const google = (scopes: string[]) => ({ Token: { type: 'oauthSetting', identityProvider: 'Google', scopes } });

describe('requiredVendorScopes', () => {
  it('derives the union per provider, and records who asked', () => {
    const r = requiredVendorScopes([
      idx('shared_googledrive', google(['https://www.googleapis.com/auth/drive'])),
      idx('shared_googletasks', google(['https://www.googleapis.com/auth/tasks'])),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].identityProvider).toBe('Google');
    expect(r[0].scopes).toEqual([
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/tasks',
    ]);
    expect(r[0].byConnector['shared_googletasks']).toEqual(['https://www.googleapis.com/auth/tasks']);
  });

  it('keeps a .readonly variant distinct from its write form', () => {
    // A DWD grant matches scope strings literally. Folding these together is exactly the
    // mistake that reported three granted scopes as missing during this work.
    const r = requiredVendorScopes([
      idx('a', google(['https://www.googleapis.com/auth/calendar'])),
      idx('b', google(['https://www.googleapis.com/auth/calendar.readonly'])),
    ]);
    expect(r[0].scopes).toHaveLength(2);
  });

  it('ignores connections that are not OAuth', () => {
    // An API-key connector needs a credential but not a scope grant; inventing a provider
    // for it would put noise in an operator's checklist.
    const r = requiredVendorScopes([idx('shared_x', { key: { type: 'securestring' } })]);
    expect(r).toEqual([]);
  });

  it('separates providers rather than pooling every scope', () => {
    const r = requiredVendorScopes([
      idx('shared_googledrive', google(['https://www.googleapis.com/auth/drive'])),
      idx('shared_office365', { Token: { type: 'oauthSetting', identityProvider: 'Aad', scopes: ['Mail.Read'] } }),
    ]);
    expect(r.map((x) => x.identityProvider)).toEqual(['Aad', 'Google']);
  });
});

describe('scopeGaps', () => {
  const required = requiredVendorScopes([
    idx('shared_googledrive', google(['https://www.googleapis.com/auth/drive'])),
    idx('shared_googletasks', google(['https://www.googleapis.com/auth/tasks'])),
  ]);

  it('names the missing scopes AND the connectors that stop working', () => {
    const gaps = scopeGaps(required, { Google: ['https://www.googleapis.com/auth/drive'] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missing).toEqual(['https://www.googleapis.com/auth/tasks']);
    // The operator needs to know the consequence, not just the string.
    expect(gaps[0].affectedConnectors).toEqual(['shared_googletasks']);
  });

  it('reports no gap when everything is granted', () => {
    expect(scopeGaps(required, {
      Google: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/tasks'],
    })).toEqual([]);
  });

  it('treats an unknown provider as entirely ungranted rather than as satisfied', () => {
    // Failing open here would report "nothing to do" for a customer who has granted nothing.
    expect(scopeGaps(required, {})[0].missing).toHaveLength(2);
  });
});

describe('space-separated scope strings', () => {
  it('splits a single OAuth scope string into the scopes an admin must grant', () => {
    // Power Platform stores scopes as OAuth sends them: one string, space separated.
    // Live: shared_googlesheet arrives as "…/auth/drive https://spreadsheets.google.com/feeds".
    // Treating that as one scope produced a grant line no console accepts.
    const r = requiredVendorScopes([
      idx('shared_googlesheet', google(['https://www.googleapis.com/auth/drive https://spreadsheets.google.com/feeds'])),
    ]);
    expect(r[0].scopes).toEqual([
      'https://spreadsheets.google.com/feeds',
      'https://www.googleapis.com/auth/drive',
    ]);
  });
});
