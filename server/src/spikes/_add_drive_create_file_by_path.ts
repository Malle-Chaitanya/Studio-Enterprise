/**
 * Adds Google Drive's `create_file_by_path` — the last remaining hand-written-only Drive
 * capability that is NOT permanently impossible (unlike extract_archive). Closes it using the
 * new, generic `createIfMissing` chain capability (operationBinding.ts / generic_rest.py):
 * resolve each '/'-separated folder segment, but CREATE it instead of refusing when a
 * segment's search comes back empty — then create the file's metadata under the final
 * resolved/created folder, then upload its content. An EMPTY/omitted `folderPath` resolves
 * to "root" with zero folder calls (see generic_rest.py's "nothing to resolve" case), which
 * is what makes "create this file in my Drive root" work without the model inventing a path.
 *
 * Nothing here is Drive-specific code — `createIfMissing` is a generic chain-step capability
 * any future connector with a similar folder hierarchy can reuse.
 *
 * Proven first against a mocked executor (scripts/_test_chain_operations.py, checks #11a/11b,
 * both passing) before being approved here — same discipline as every other approval this
 * project: marked `approved` as an informed risk acceptance for live testing, not because it
 * was proven against a real Drive yet.
 *
 *   npx tsx src/spikes/_add_drive_create_file_by_path.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_googledrive';
const CATALOG_VERSION = 1;

await connectMongo();

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'create_file_by_path',
  displayName: 'Create file by path',
  method: 'POST',
  path: '',
  parameters: [
    {
      name: 'folderPath',
      in: 'query',
      required: false,
      type: 'string',
      description:
        "Parent folder path, e.g. \"Reports/2026/Q1\" — any folder segment that doesn't " +
        'already exist is created. Omit (or pass empty) to create the file directly in ' +
        'Drive\'s root — do not pass "root" or "/" for that, just leave it out.',
    },
    { name: 'name', in: 'query', required: true, type: 'string' },
    {
      name: 'content', in: 'query', required: true, type: 'string',
      // Plain TEXT content only — same restriction as create_file (CreateFileV2): the
      // generic executor has no per-parameter validation concept yet, so this is enforced
      // by instruction, not code, same documented gap as that operation.
    },
    { name: 'mimeType', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  chain: [
    {
      method: 'GET',
      urlTemplate:
        "https://www.googleapis.com/drive/v3/files?q=%27{parentId}%27+in+parents+and+name=%27{segment}%27" +
        "+and+mimeType=%27application/vnd.google-apps.folder%27+and+trashed=false" +
        '&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true',
      extractPath: 'files',
      itemIdField: 'id',
      bindAs: 'parentId',
      initialValue: 'root',
      itemNoun: 'folder',
      repeatOverParam: 'folderPath',
      createIfMissing: {
        method: 'POST',
        urlTemplate: 'https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true',
        bodyTemplate: {
          name: '{segment}',
          parents: ['{parentId}'],
          mimeType: 'application/vnd.google-apps.folder',
        },
        itemIdField: 'id',
      },
    },
    {
      method: 'POST',
      urlTemplate: 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true',
      bodyTemplate: { name: '{name}', parents: ['{parentId}'], mimeType: '{mimeType}' },
      extractPath: 'id',
      bindAs: 'fileId',
    },
    {
      method: 'PATCH',
      urlTemplate:
        'https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media' +
        '&fields=id,name,webViewLink&supportsAllDrives=true',
      bodyFromParam: 'content',
      bodyContentTypeParam: 'mimeType',
    },
  ],
  sourceOperationIds: [],
  alwaysOnForConnector: true,
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log('Added Google Drive create_file_by_path — approved, chain-executed (createIfMissing).');
process.exit(0);
