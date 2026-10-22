/**
 * Replaces the 4 Google Drive operations seeded as `unsupported` with real, working,
 * fully database-driven definitions — the "chain" mechanism (operationBinding.ts's
 * ChainStep, executed by generic_rest.py's `_invoke_chain`) built specifically to make
 * this possible. No hand-written per-connector code: these are data rows, executed by the
 * same generic engine every other catalog operation already uses.
 *
 * UpdateFile needed no chain at all — just the Content-Type fix already made in
 * generic_rest.py's `_invoke` (it used to force `application/json` on every body,
 * clobbering a declared Content-Type header param).
 *
 * CreateFileV2 and the two get-by-path operations genuinely are not one HTTP call:
 *   - CreateFileV2: create the metadata row, THEN upload content to the id it returned.
 *   - GetFileMetadataByPath / GetFileContentByPath: Drive has no path lookup, only
 *     name-within-parent search — resolved one path segment at a time, each using the
 *     previous segment's resolved folder id, exactly like the dedicated file's own
 *     (now-redundant) `google_drive_find_by_path` already did.
 *
 * Proven first against a mocked executor (scripts/_test_chain_operations.py, 9/9 passing)
 * before being approved here — same discipline as every other approval tonight: marked
 * `approved` as an explicit, informed risk acceptance for live testing, not because it was
 * proven against a real tenant yet.
 *
 *   npx tsx src/spikes/_update_drive_chain_operations.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_ID = 'shared_googledrive';
const CATALOG_VERSION = 1;

await connectMongo();

// Shared by both get-by-path operations: resolve each '/'-separated path segment, one Drive
// search per segment, carrying the resolved parent id forward — then a final step using the
// last-resolved id.
const RESOLVE_PATH_STEP = {
  method: 'GET',
  urlTemplate:
    "https://www.googleapis.com/drive/v3/files?q=%27{parentId}%27+in+parents+and+name=%27{segment}%27" +
    '+and+trashed=false&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true',
  extractPath: 'files',
  itemIdField: 'id',
  bindAs: 'parentId',
  initialValue: 'root',
  itemNoun: 'item',
  repeatOverParam: 'path',
};

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'create_file',
  displayName: 'Create file (V2)',
  method: 'POST',
  path: '',
  parameters: [
    { name: 'name', in: 'query', required: true, type: 'string' },
    { name: 'folderId', in: 'query', required: true, type: 'string' },
    {
      name: 'content', in: 'query', required: true, type: 'string',
      // Plain TEXT content only — same restriction the old dedicated file enforced in code
      // ("this tool only writes plain text content, it does not generate a genuine Word/
      // Excel/PDF binary structure"). The generic executor has no per-parameter validation
      // concept yet, so this is enforced by instruction, not code — a real, documented gap,
      // not a silent one.
    },
    // REQUIRED, not optional: an omitted value would leave the literal text "{mimeType}" in
    // both the metadata body and the Content-Type header — now caught by generic_rest.py's
    // unresolved-placeholder check (refuses clearly) rather than corrupting the request, but
    // still better avoided than relied on. Model is expected to pass "text/plain" itself when
    // the customer doesn't care.
    { name: 'mimeType', in: 'query', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  chain: [
    {
      method: 'POST',
      urlTemplate: 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true',
      bodyTemplate: { name: '{name}', parents: ['{folderId}'], mimeType: '{mimeType}' },
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
  sourceOperationIds: ['CreateFileV2'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'update_file',
  displayName: 'Update file',
  method: 'PATCH',
  path: '/upload/drive/v3/files/{fileId}?uploadType=media&supportsAllDrives=true',
  parameters: [
    { name: 'fileId', in: 'path', required: true, type: 'string' },
    { name: 'body', in: 'body', required: true, type: 'string' }, // the new raw content, as plain text
    { name: 'Content-Type', in: 'header', required: true, type: 'string' }, // e.g. "text/plain"
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['UpdateFile'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_file_metadata_by_path',
  displayName: 'Get file metadata using path',
  method: 'GET',
  path: '',
  parameters: [{ name: 'path', in: 'query', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  chain: [
    RESOLVE_PATH_STEP,
    {
      method: 'GET',
      urlTemplate:
        'https://www.googleapis.com/drive/v3/files/{parentId}' +
        '?fields=id,name,mimeType,size,modifiedTime,webViewLink,trashed&supportsAllDrives=true',
    },
  ],
  sourceOperationIds: ['GetFileMetadataByPath'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CONNECTOR_ID,
  operationKey: 'get_file_content_by_path',
  displayName: 'Get file content using path',
  method: 'GET',
  path: '',
  parameters: [{ name: 'path', in: 'query', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  response: { contentType: 'binary-image' }, // non-JSON body, same caveat as get_file_content_by_id
  chain: [
    RESOLVE_PATH_STEP,
    { method: 'GET', urlTemplate: 'https://www.googleapis.com/drive/v3/files/{parentId}?alt=media&supportsAllDrives=true' },
  ],
  sourceOperationIds: ['GetFileContentByPath'],
  lifecycle: { status: 'approved' },
  catalogVersion: CATALOG_VERSION,
});

console.log(
  'Updated 4 Google Drive operations from unsupported -> approved, chain-executed: ' +
    'create_file, update_file, get_file_metadata_by_path, get_file_content_by_path.',
);
process.exit(0);
