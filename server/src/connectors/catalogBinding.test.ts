import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bindAlwaysOnOperations, bindFromCatalog } from './catalogBinding.js';
import type { CatalogConnector, CatalogOperation } from '../db/repos/connectorCatalog.js';

/**
 * `bindFromCatalog` is the lifecycle GATE — the piece confirmed missing by the 2026-10-20
 * audit, where 'candidate' silently deployed identically to 'approved'. These lock the fix:
 * only 'approved' may bind, the '/me'-style delegated refusal is unconditional and checked
 * before lifecycle (so it fires even on a row someone mismarks 'approved'), and every other
 * lifecycle value — including ones the TS type claims cannot happen — is treated as NOT
 * ready rather than assumed safe. The repo is mocked: this is pure decision logic, not a
 * database test (see connectorCatalog.test.ts for that).
 */

vi.mock('../db/repos/connectorCatalog.js', () => ({
  findCatalogOperationBySourceId: vi.fn(),
  getCatalogConnector: vi.fn(),
  listApprovedAlwaysOnOperations: vi.fn(),
}));

import { findCatalogOperationBySourceId, getCatalogConnector, listApprovedAlwaysOnOperations } from '../db/repos/connectorCatalog.js';

const mockFind = vi.mocked(findCatalogOperationBySourceId);
const mockConnector = vi.mocked(getCatalogConnector);
const mockAlwaysOn = vi.mocked(listApprovedAlwaysOnOperations);

const CONNECTOR_ID = 'shared_office365users';

const connector: CatalogConnector = {
  connectorId: CONNECTOR_ID,
  displayName: 'Office 365 Users',
  vendor: 'microsoft',
  apiFamily: 'microsoft_graph',
  baseUrl: 'https://graph.microsoft.com/v1.0',
  authKind: 'oauth2-client-credentials',
  status: 'candidate',
  catalogVersion: 1,
  updatedAt: new Date(),
};

/** Build one operation row with sensible defaults, overridden per test. */
function op(overrides: Partial<CatalogOperation>): CatalogOperation {
  return {
    connectorId: CONNECTOR_ID,
    operationKey: 'get_user',
    displayName: 'Get user profile',
    method: 'GET',
    path: '/users/{userId}',
    parameters: [{ name: 'userId', in: 'path', required: true, type: 'string' }],
    auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'], requiresAdminConsent: true },
    sourceOperationIds: ['GetUserV2'],
    lifecycle: { status: 'approved' },
    catalogVersion: 1,
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  mockFind.mockReset();
  mockConnector.mockReset();
  mockAlwaysOn.mockReset();
  mockConnector.mockResolvedValue(connector);
});

describe('bindFromCatalog — lifecycle gate', () => {
  it('REGRESSION: an approved operation (get_user) binds to the real Graph call', async () => {
    mockFind.mockResolvedValue(op({ lifecycle: { status: 'approved' } }));
    const result = await bindFromCatalog(CONNECTOR_ID, 'GetUserV2');
    expect(result.status).toBe('bindable');
    if (result.status === 'bindable') {
      expect(result.operation.method).toBe('GET');
      expect(result.operation.urlTemplate).toBe('https://graph.microsoft.com/v1.0/users/{userId}');
      expect(result.operation.auth).toBe('aad-token');
      expect(result.operation.aadResource).toBe('https://graph.microsoft.com');
    }
  });

  it('refuses a "candidate" operation — the exact gap the 2026-10-20 audit found', async () => {
    mockFind.mockResolvedValue(op({ lifecycle: { status: 'candidate' } }));
    const result = await bindFromCatalog(CONNECTOR_ID, 'SearchUserV2');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reason).toMatch(/candidate/i);
      expect(result.reason).toMatch(/not yet verified/i);
    }
  });

  it('refuses an "unsupported" operation with its recorded reason, not a generic one', async () => {
    mockFind.mockResolvedValue(
      op({
        operationKey: 'raw_http_request',
        lifecycle: { status: 'unsupported' },
        unsupportedReason: 'can call any address, cannot be safely rebuilt',
      }),
    );
    const result = await bindFromCatalog(CONNECTOR_ID, 'HttpRequest');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reason).toBe('can call any address, cannot be safely rebuilt');
    }
  });

  it('refuses a row with NO lifecycle.status at all — a malformed document is never assumed safe', async () => {
    // @ts-expect-error — deliberately constructing the malformed-document case the TS type
    // claims cannot happen; Mongo does not enforce the interface at the database level.
    mockFind.mockResolvedValue(op({ lifecycle: {} }));
    const result = await bindFromCatalog(CONNECTOR_ID, 'GetUserV2');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') expect(result.reason).toMatch(/no lifecycle status recorded/i);
  });

  it('refuses a row with an UNRECOGNIZED lifecycle.status value', async () => {
    // @ts-expect-error — same reasoning as above: a hand-edited or future-schema document.
    mockFind.mockResolvedValue(op({ lifecycle: { status: 'in-review' } }));
    const result = await bindFromCatalog(CONNECTOR_ID, 'GetUserV2');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reason).toMatch(/unrecognized/i);
      expect(result.reason).toContain('in-review');
    }
  });

  it('refuses a delegated-mode operation UNCONDITIONALLY, even if someone marks it "approved"', async () => {
    // The structural fact (no "whoever" under an app-only credential) must win even over an
    // operator's mistaken approval — this is checked first, before the lifecycle gate.
    mockFind.mockResolvedValue(
      op({
        operationKey: 'get_my_profile',
        path: '/me',
        auth: { mode: 'delegated', requiredPermissions: ['User.Read'] },
        lifecycle: { status: 'approved' },
      }),
    );
    const result = await bindFromCatalog(CONNECTOR_ID, 'MyProfile_V2');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reason).toMatch(/real signed-in person/i);
      // Must NOT be swallowed by the generic lifecycle message.
      expect(result.reason).not.toMatch(/candidate/i);
    }
  });

  it('appends a binary-response note for a candidate operation whose response is an image', async () => {
    mockFind.mockResolvedValue(
      op({
        operationKey: 'get_photo',
        path: '/users/{userId}/photo/$value',
        lifecycle: { status: 'candidate' },
        response: { contentType: 'binary-image' },
      }),
    );
    const result = await bindFromCatalog(CONNECTOR_ID, 'UserPhoto');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') expect(result.reason).toMatch(/binary image, not JSON/i);
  });

  it('propagates resultPath and pagination metadata onto the bound operation (step 3 plumbing)', async () => {
    mockFind.mockResolvedValue(
      op({
        operationKey: 'list_users',
        path: '/users',
        lifecycle: { status: 'approved' },
        response: { resultPath: 'value', pagination: { strategy: 'next-link-field', field: '@odata.nextLink' } },
      }),
    );
    const result = await bindFromCatalog(CONNECTOR_ID, 'SearchUserV2');
    expect(result.status).toBe('bindable');
    if (result.status === 'bindable') {
      expect(result.operation.resultPath).toBe('value');
      expect(result.operation.pagination).toEqual({ strategy: 'next-link-field', field: '@odata.nextLink' });
    }
  });

  it('propagates catalogVersion onto the bound operation (step 4 pinning plumbing)', async () => {
    mockFind.mockResolvedValue(op({ lifecycle: { status: 'approved' }, catalogVersion: 3 }));
    const result = await bindFromCatalog(CONNECTOR_ID, 'GetUserV2');
    expect(result.status).toBe('bindable');
    if (result.status === 'bindable') expect(result.operation.catalogVersion).toBe(3);
  });

  it('an operation unknown to the catalog reports not-in-catalog, not a fabricated refusal', async () => {
    mockFind.mockResolvedValue(null);
    const result = await bindFromCatalog(CONNECTOR_ID, 'SomethingNeverCataloged');
    expect(result.status).toBe('not-in-catalog');
  });

  it('refuses when the connector declares an auth kind this executor does not know how to run', async () => {
    mockConnector.mockResolvedValue({ ...connector, authKind: 'some-future-kind' });
    mockFind.mockResolvedValue(op({ lifecycle: { status: 'approved' } }));
    const result = await bindFromCatalog(CONNECTOR_ID, 'GetUserV2');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') expect(result.reason).toMatch(/does not yet know how to run/i);
  });

  it('reports not-in-catalog if the connector row itself is missing, even with a valid operation', async () => {
    mockConnector.mockResolvedValue(null);
    mockFind.mockResolvedValue(op({ lifecycle: { status: 'approved' } }));
    const result = await bindFromCatalog(CONNECTOR_ID, 'GetUserV2');
    expect(result.status).toBe('not-in-catalog');
  });

  it('resolves a "google-service-account" connector to the google-oauth executor path (Google connector pilot)', async () => {
    // Added alongside the Google Drive/Sheets/Contacts/Calendar/Tasks/Gmail catalog pilot.
    // generic_rest.py only special-cases auth === "aad-token"; anything else — including
    // "google-oauth" — falls through to the already-proven `auth_header(fill)` Google
    // service-account/DWD minting in adk_deploy.py, so there is no AAD resource to compute.
    mockConnector.mockResolvedValue({
      ...connector,
      connectorId: 'shared_googlesheet',
      authKind: 'google-service-account',
      baseUrl: 'https://sheets.googleapis.com',
    });
    mockFind.mockResolvedValue(
      op({
        connectorId: 'shared_googlesheet',
        operationKey: 'get_sheets',
        path: '/v4/spreadsheets/{spreadsheetId}',
        auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/spreadsheets'] },
        sourceOperationIds: ['GetTables'],
        lifecycle: { status: 'approved' },
      }),
    );
    const result = await bindFromCatalog('shared_googlesheet', 'GetTables');
    expect(result.status).toBe('bindable');
    if (result.status === 'bindable') {
      expect(result.operation.auth).toBe('google-oauth');
      expect(result.operation.urlTemplate).toBe('https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}');
      expect(result.operation.aadResource).toBeUndefined();
    }
  });
});

describe('bindAlwaysOnOperations — bonus capabilities with no Microsoft source equivalent', () => {
  it('binds every approved always-on row for the connector, keyed on operationKey not a source id', async () => {
    mockConnector.mockResolvedValue({ ...connector, connectorId: 'shared_gmail', authKind: 'google-service-account', baseUrl: 'https://gmail.googleapis.com' });
    mockAlwaysOn.mockResolvedValue([
      op({
        connectorId: 'shared_gmail',
        operationKey: 'list_labels',
        displayName: 'List labels',
        path: '/gmail/v1/users/{userId}/labels',
        auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
        sourceOperationIds: [],
        alwaysOnForConnector: true,
        lifecycle: { status: 'approved' },
      }),
    ]);
    const result = await bindAlwaysOnOperations('shared_gmail');
    expect(result).toHaveLength(1);
    expect(result[0].operation.operationId).toBe('list_labels'); // the operationKey, not a source id -- there is none
    expect(result[0].operation.urlTemplate).toBe('https://gmail.googleapis.com/gmail/v1/users/{userId}/labels');
  });

  it('returns nothing when the connector row itself is missing', async () => {
    mockConnector.mockResolvedValue(null);
    const result = await bindAlwaysOnOperations('shared_gmail');
    expect(result).toEqual([]);
    expect(mockAlwaysOn).not.toHaveBeenCalled();
  });

  it('silently skips a row whose auth kind this executor cannot run, rather than throwing', async () => {
    mockConnector.mockResolvedValue({ ...connector, connectorId: 'shared_gmail', authKind: 'some-future-kind' });
    mockAlwaysOn.mockResolvedValue([op({ connectorId: 'shared_gmail', operationKey: 'list_labels', sourceOperationIds: [], alwaysOnForConnector: true })]);
    const result = await bindAlwaysOnOperations('shared_gmail');
    expect(result).toEqual([]);
  });
});
