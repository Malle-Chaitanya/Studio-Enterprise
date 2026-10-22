/**
 * Adds Google Drive's two bonus capabilities with NO Microsoft source equivalent — confirmed
 * directly against Microsoft's real connector reference page (re-checked 2026-10-22: no
 * "create folder" or "search by name" action exists there at all) — as `alwaysOnForConnector`
 * rows. These were never reachable by matching a migrated agent's extracted tool call,
 * because no such Copilot Studio action was ever offered to create one; they're offered
 * unconditionally whenever Drive is configured, the same way google_drive.py's
 * `create_folder`/`search_by_name` functions always were.
 *
 *   npx tsx src/spikes/_add_drive_always_on_ops.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_googledrive';
const CATALOG_VERSION = 1;

await connectMongo();

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'create_folder',
  displayName: 'Create folder',
  method: 'POST',
  path: '/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true',
  parameters: [
    { name: 'name', in: 'query', required: true, type: 'string' },
    // REQUIRED, not optional-with-an-assumed-default: the executor has no notion of
    // defaults, so an omitted value would leave the literal text "{parentId}" in the
    // request rather than silently using root — confirmed by a real test of exactly
    // this case. The model is told in the description to pass "root" itself when the
    // customer means the top level.
    { name: 'parentId', in: 'query', required: true, type: 'string', description: 'The Drive folder id to create this folder in. Pass "root" for the top level of My Drive.' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  chain: [
    {
      method: 'POST',
      urlTemplate: 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true',
      bodyTemplate: {
        name: '{name}',
        parents: ['{parentId}'],
        mimeType: 'application/vnd.google-apps.folder',
      },
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'search_by_name',
  displayName: 'Search Drive by name',
  method: 'GET',
  path: "/drive/v3/files?q=name=%27{name}%27+and+trashed=false&fields=files(id,name,mimeType,parents)&supportsAllDrives=true&includeItemsFromAllDrives=true",
  parameters: [{ name: 'name', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  response: { resultPath: 'files' },
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log('Added 2 always-on Drive operations: create_folder, search_by_name.');
process.exit(0);
