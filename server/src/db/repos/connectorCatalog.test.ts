import { describe, it, expect } from 'vitest';
import {
  getCatalogConnector,
  findCatalogOperationBySourceId,
  listCatalogOperations,
  putCatalogConnector,
  putCatalogOperation,
} from './connectorCatalog.js';

/**
 * Same posture as every other repo in this codebase (see agentSurfaceChoice.test.ts):
 * these run with NO database connected, which is the realistic worst case — a Mongo outage
 * must degrade quietly, not break the migration or the catalog lookup mid-run. Covers the
 * repo's own contract only; `catalogBinding.test.ts` covers the decision logic that sits on
 * top of it, with the repo mocked.
 */
describe('connectorCatalog repo degrades safely with no database connected', () => {
  it('getCatalogConnector resolves to null, never throws', async () => {
    await expect(getCatalogConnector('shared_office365users')).resolves.toBeNull();
  });

  it('findCatalogOperationBySourceId resolves to null, never throws', async () => {
    await expect(findCatalogOperationBySourceId('shared_office365users', 'GetUserV2')).resolves.toBeNull();
  });

  it('listCatalogOperations resolves to an empty array, never throws', async () => {
    await expect(listCatalogOperations('shared_office365users')).resolves.toEqual([]);
  });

  it('putCatalogConnector resolves without throwing — a write during an outage is silently skipped, not fatal', async () => {
    await expect(
      putCatalogConnector({
        connectorId: 'shared_office365users',
        displayName: 'Office 365 Users',
        vendor: 'microsoft',
        apiFamily: 'microsoft_graph',
        baseUrl: 'https://graph.microsoft.com/v1.0',
        authKind: 'oauth2-client-credentials',
        status: 'candidate',
        catalogVersion: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('putCatalogOperation resolves without throwing', async () => {
    await expect(
      putCatalogOperation({
        connectorId: 'shared_office365users',
        operationKey: 'get_user',
        displayName: 'Get user profile',
        method: 'GET',
        path: '/users/{userId}',
        parameters: [],
        auth: { mode: 'app-only', requiredPermissions: ['User.Read.All'] },
        sourceOperationIds: ['GetUserV2'],
        lifecycle: { status: 'approved' },
        catalogVersion: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
