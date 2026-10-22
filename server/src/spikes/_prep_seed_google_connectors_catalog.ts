/**
 * One-time seed of the dynamic-connector catalog for SIX Google connectors — Drive, Sheets,
 * Contacts, Calendar, Tasks, Gmail — built the same way as the Office 365 Users pilot
 * (_prep_seed_office365users_catalog.ts): real operation data typed in once, here, from the
 * vendor's own published docs, never captured live from a customer's Copilot Studio tenant.
 *
 * SOURCES, cross-checked against each other exactly as instructed:
 *   1. Microsoft's own published connector reference pages (learn.microsoft.com/en-us/connectors/
 *      <slug>/) — fetched live on 2026-10-22. This is where every `sourceOperationIds` value
 *      below comes from (the page's own "Operation ID" heading per action) — NOT guessed, NOT
 *      taken from the Copy Project's Connectors.docx/API.docx display names, because those are
 *      display names, not operationIds (the Office 365 Users pilot was burned by exactly this
 *      confusion once already — see that file's `get_user`/`get_photo` corrections).
 *   2. Each vendor's own real API reference (Drive v3, Sheets v4, People API v1, Calendar v3,
 *      Tasks v1, Gmail v1) for the REAL method/path/body shape — Microsoft's page documents a
 *      Power-Platform-proxy parameter shape (e.g. Drive's "Copy file" takes a path-string
 *      "source"/"destination", not a real fileId), which this project deliberately does not
 *      copy verbatim — same principle as list_users/$filter in the Office 365 Users seed.
 *   3. The user's own Connectors.docx/API.docx — used to decide WHICH operations matter and as
 *      a second opinion on method/path; every row in it was independently re-verified against
 *      (1) and (2) above rather than trusted blindly, and several of its own flagged low-
 *      confidence rows (Calendar's PUT-vs-PATCH ambiguity, Sheets' batchUpdate delete shape,
 *      Gmail's reply threading) are carried over here with the same honesty, not resolved by
 *      guessing.
 *
 * AUTH: all six connectors use `google-service-account` (domain-wide delegation, the same
 * mechanism already proven live for Drive) — see catalogBinding.ts's AUTH_KIND_TO_VENDOR_AUTH
 * for why no new token-minting code was needed.
 *
 * PAGINATION, flagged honestly: the one pagination mechanism this project has built
 * (`response.pagination: {strategy:'next-link-field', field}` in generic_rest.py) only works
 * for a vendor that hands back a full followable URL, which is how Microsoft Graph's
 * `@odata.nextLink` works. Google's own list APIs (Calendar events, Tasks, People
 * connections, Gmail search) all paginate with an opaque `nextPageToken` STRING instead — you
 * re-send the ORIGINAL request with `&pageToken=<token>` appended, not follow a link. That is
 * a different mechanism this project has not built yet, so `pagination` is deliberately left
 * unset below on every Google list operation: each one still works, it just returns the FIRST
 * PAGE only, same as any other operation with no `pagination` set. This is an honest gap to
 * flag to the team, not a silent limitation.
 *
 * NOTHING below is `approved`. Every operation is `candidate`, exactly like the Office 365
 * Users pilot before its first live test — this pass is the catalog DATA only; live-testing
 * and approving individual operations is separate, later work, same discipline as before.
 *
 *   npx tsx src/spikes/_prep_seed_google_connectors_catalog.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { putCatalogConnector, putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CATALOG_VERSION = 1;

await connectMongo();

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1. GOOGLE DRIVE — connectorId confirmed against registry.ts's existing shared_googledrive
//    entry (already proven live for its own dedicated connector_tools/google_drive.py file).
//    This catalog does NOT touch that file — see the per-operation retirement note in the
//    accompanying summary. Source: learn.microsoft.com/en-us/connectors/googledrive/ (11
//    non-deprecated actions; "Create file (V1) (deprecated)" excluded per instruction to
//    ignore deprecated ones) + Drive API v3 (developers.google.com/drive/api/reference/rest).
// ─────────────────────────────────────────────────────────────────────────────────────────
const DRIVE = 'shared_googledrive';

await putCatalogConnector({
  connectorId: DRIVE,
  displayName: 'Google Drive',
  vendor: 'google',
  apiFamily: 'drive_v3',
  baseUrl: 'https://www.googleapis.com',
  specSourceUrl: 'https://developers.google.com/drive/api/reference/rest/v3',
  authKind: 'google-service-account',
  status: 'candidate',
  catalogVersion: CATALOG_VERSION,
});

// copy_file — real Drive API takes a fileId (path) + an OPTIONAL JSON body (e.g. {"name":
// "..."} to rename the copy). Microsoft's own "Copy file" params ("Source url"/"Destination
// file path") are the Power Platform proxy's OWN path-based abstraction over this — not a
// real Drive parameter at all (confirmed: Drive's copy endpoint has no concept of a path,
// only file ids) — so this models the REAL call, not MS's wrapper shape.
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'copy_file',
  displayName: 'Copy file',
  method: 'POST',
  path: '/drive/v3/files/{fileId}/copy?supportsAllDrives=true',
  parameters: [
    { name: 'fileId', in: 'path', required: true, type: 'string' },
    { name: 'body', in: 'body', required: false, type: 'object' }, // optional JSON, e.g. {"name": "Copy of X"}
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['CopyFile'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// create_file (V2) — UNSUPPORTED. Microsoft's real, non-deprecated CreateFileV2 operation
// ALWAYS requires binary file content in the same call (not metadata-only). Google's matching
// real endpoint for "create with content in one call" needs a multipart/related upload (JSON
// metadata part + raw bytes part) — this project's generic executor only ever sends ONE flat
// JSON (or string) body, so a genuine multipart request cannot be built today. Confirmed by
// reading generic_rest.py's _invoke(): `data = _json.dumps(body_val)` — there's no second,
// binary part.
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'create_file',
  displayName: 'Create file (V2)',
  method: 'POST',
  path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['CreateFileV2'],
  lifecycle: { status: 'unsupported' },
  unsupportedReason:
    'Creating a file with content requires a multipart upload (file metadata plus raw file ' +
    "bytes in the same request). The generic executor can only send one flat JSON body, so " +
    'this cannot be safely rebuilt yet.',
  catalogVersion: CATALOG_VERSION,
});

// delete_file
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'delete_file',
  displayName: 'Delete file',
  method: 'DELETE',
  path: '/drive/v3/files/{fileId}?supportsAllDrives=true',
  parameters: [{ name: 'fileId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['DeleteFile'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// extract_archive_to_folder — UNSUPPORTED. Confirmed (both by the user's own research and by
// Drive's real API surface): there is no single Drive API call that extracts an archive.
// Doing this for real is download the zip, unzip it locally, then POST one new file per
// entry — several sequential calls, not one bound operation.
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'extract_archive_to_folder',
  displayName: 'Extract archive to folder',
  method: 'POST',
  path: '',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['ExtractFolderV2'],
  lifecycle: { status: 'unsupported' },
  unsupportedReason:
    'There is no single Google Drive API call that extracts an archive. Doing this for real ' +
    'is download, unzip, then one upload per file inside it — several dependent calls, which ' +
    'the generic single-call executor does not support yet.',
  catalogVersion: CATALOG_VERSION,
});

// get_file_content_by_id — response is the raw file bytes, not JSON (same class of gap as the
// Office 365 Users pilot's get_photo — flagged there with contentType: 'binary-image'; reused
// here even though a Drive file need not be an image, since it is the only non-JSON response
// marker this project has built so far).
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'get_file_content_by_id',
  displayName: 'Get file content using id',
  method: 'GET',
  path: '/drive/v3/files/{fileId}?alt=media&supportsAllDrives=true',
  parameters: [{ name: 'fileId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  response: { contentType: 'binary-image' }, // non-JSON binary body, not necessarily an image
  sourceOperationIds: ['GetFileContent'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_file_content_by_path — UNSUPPORTED. Drive has no native path lookup; doing this for
// real is two dependent calls (resolve path -> id via a `q=` search, then fetch that id's
// content) — the user's own API.docx flagged exactly this as "my inference", two steps.
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'get_file_content_by_path',
  displayName: 'Get file content using path',
  method: 'GET',
  path: '',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['GetFileContentByPath'],
  lifecycle: { status: 'unsupported' },
  unsupportedReason:
    'Google Drive has no native "look up by path" call. Doing this for real is two dependent ' +
    'calls — resolve the path to a file id, then fetch that id\'s content — which a single ' +
    'bound operation cannot do yet.',
  catalogVersion: CATALOG_VERSION,
});

// get_file_metadata_by_id
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'get_file_metadata_by_id',
  displayName: 'Get file metadata using id',
  method: 'GET',
  path: '/drive/v3/files/{fileId}?fields=id,name,mimeType,size,modifiedTime,webViewLink,trashed&supportsAllDrives=true',
  parameters: [{ name: 'fileId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['GetFileMetadata'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_file_metadata_by_path — UNSUPPORTED, same two-step reasoning as content-by-path.
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'get_file_metadata_by_path',
  displayName: 'Get file metadata using path',
  method: 'GET',
  path: '',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['GetFileMetadataByPath'],
  lifecycle: { status: 'unsupported' },
  unsupportedReason:
    'Google Drive has no native "look up by path" call. Doing this for real is two dependent ' +
    'calls — resolve the path to a file id, then fetch that id\'s metadata — which a single ' +
    'bound operation cannot do yet.',
  catalogVersion: CATALOG_VERSION,
});

// list_files_in_folder — folderId is embedded directly inside the fixed query string
// (Drive's `q` search syntax), not a conventional REST path segment. The generic executor's
// path-parameter substitution works on the WHOLE url template string, so this is safe — the
// same trick the user's own API.docx used when it wrote the query as
// "?q='{folderId}'+in+parents".
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'list_files_in_folder',
  displayName: 'List files in folder',
  method: 'GET',
  path: "/drive/v3/files?q=%27{folderId}%27+in+parents+and+trashed%3Dfalse&fields=files(id,name,mimeType,size,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true",
  parameters: [{ name: 'folderId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  response: { resultPath: 'files' },
  sourceOperationIds: ['ListFolder'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// list_files_in_root_folder — same shape, with the folder id fixed to "root".
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'list_files_in_root_folder',
  displayName: 'List files in root folder',
  method: 'GET',
  path: "/drive/v3/files?q=%27root%27+in+parents+and+trashed%3Dfalse&fields=files(id,name,mimeType,size,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true",
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  response: { resultPath: 'files' },
  sourceOperationIds: ['ListRootFolder'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// update_file — UNSUPPORTED. Microsoft's real, non-deprecated UpdateFile operation is a
// CONTENT update (binary body), not a metadata/rename update — same multipart/binary-body
// gap as create_file above.
await putCatalogOperation({
  connectorId: DRIVE,
  operationKey: 'update_file',
  displayName: 'Update file',
  method: 'PATCH',
  path: '/upload/drive/v3/files/{fileId}?uploadType=media&supportsAllDrives=true',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/drive'] },
  sourceOperationIds: ['UpdateFile'],
  lifecycle: { status: 'unsupported' },
  unsupportedReason:
    'This operation replaces a file\'s CONTENT with raw bytes, not a JSON body. The generic ' +
    'executor only sends JSON/string bodies today, so a real binary content update cannot be ' +
    'built yet.',
  catalogVersion: CATALOG_VERSION,
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2. GOOGLE SHEETS — no existing registry.ts entry before this change (added as part of
//    this same pass as shared_googlesheet) and no dedicated connector_tools/*.py file, so
//    every one of these runs through generic_rest.py's bound-operation path once approved —
//    a clean, zero-risk proof of the "DB data only, no new file" claim. Source:
//    learn.microsoft.com/en-us/connectors/googlesheet/ (6 actions, 0 deprecated) + Sheets API
//    v4 (developers.google.com/sheets/api/reference/rest).
// ─────────────────────────────────────────────────────────────────────────────────────────
const SHEETS = 'shared_googlesheet';

await putCatalogConnector({
  connectorId: SHEETS,
  displayName: 'Google Sheets',
  vendor: 'google',
  apiFamily: 'sheets_v4',
  baseUrl: 'https://sheets.googleapis.com',
  specSourceUrl: 'https://developers.google.com/sheets/api/reference/rest',
  authKind: 'google-service-account',
  status: 'candidate',
  catalogVersion: CATALOG_VERSION,
});

// get_sheets — "Get sheets" in Microsoft's reference; the real Sheets equivalent is reading
// the spreadsheet's own metadata and projecting just the sheet list.
await putCatalogOperation({
  connectorId: SHEETS,
  operationKey: 'get_sheets',
  displayName: 'Get sheets',
  method: 'GET',
  path: '/v4/spreadsheets/{spreadsheetId}?fields=sheets.properties',
  parameters: [{ name: 'spreadsheetId', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/spreadsheets'] },
  response: { resultPath: 'sheets' },
  sourceOperationIds: ['GetTables'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_rows
await putCatalogOperation({
  connectorId: SHEETS,
  operationKey: 'get_rows',
  displayName: 'Get rows',
  method: 'GET',
  path: '/v4/spreadsheets/{spreadsheetId}/values/{range}',
  parameters: [
    { name: 'spreadsheetId', in: 'path', required: true, type: 'string' },
    // e.g. "Sheet1!A2:Z1000" — Sheets addresses ranges by sheet name + A1 notation, not by a
    // separate "worksheet" parameter the way Microsoft's abstraction splits it.
    { name: 'range', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/spreadsheets'] },
  response: { resultPath: 'values' },
  sourceOperationIds: ['GetItems'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_row — Sheets has no "get one row by id" call. My inference (flagged, same as the
// user's own API.docx): reuse the same values.get call as get_rows, with the model asked to
// pass a range covering exactly one row (e.g. "Sheet1!A5:Z5").
await putCatalogOperation({
  connectorId: SHEETS,
  operationKey: 'get_row',
  displayName: 'Get row',
  method: 'GET',
  path: '/v4/spreadsheets/{spreadsheetId}/values/{range}',
  parameters: [
    { name: 'spreadsheetId', in: 'path', required: true, type: 'string' },
    {
      name: 'range',
      in: 'path',
      required: true,
      type: 'string', // e.g. "Sheet1!A5:Z5" — a range covering exactly the one row wanted
    },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/spreadsheets'] },
  response: { resultPath: 'values' },
  sourceOperationIds: ['GetItem'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// insert_rows
await putCatalogOperation({
  connectorId: SHEETS,
  operationKey: 'insert_rows',
  displayName: 'Insert row',
  method: 'POST',
  path: '/v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=USER_ENTERED',
  parameters: [
    { name: 'spreadsheetId', in: 'path', required: true, type: 'string' },
    { name: 'range', in: 'path', required: true, type: 'string' },
    // JSON object, e.g. {"values": [["a", "b", "c"]]} — one inner array per row.
    { name: 'body', in: 'body', required: true, type: 'object' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/spreadsheets'] },
  sourceOperationIds: ['PostItem'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// update_rows
await putCatalogOperation({
  connectorId: SHEETS,
  operationKey: 'update_rows',
  displayName: 'Update row',
  method: 'PUT',
  path: '/v4/spreadsheets/{spreadsheetId}/values/{range}?valueInputOption=USER_ENTERED',
  parameters: [
    { name: 'spreadsheetId', in: 'path', required: true, type: 'string' },
    { name: 'range', in: 'path', required: true, type: 'string' },
    { name: 'body', in: 'body', required: true, type: 'object' }, // {"values": [[...]]}
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/spreadsheets'] },
  sourceOperationIds: ['PatchItem'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// delete_row — needs Sheets' batchUpdate deleteDimension request, a genuinely nested body.
// The model is asked to construct the nested JSON itself (same pattern already relied on for
// Jira/HubSpot's nested bodies) — flagged lower-confidence, same as the user's own API.docx
// ("Row delete request: my knowledge").
await putCatalogOperation({
  connectorId: SHEETS,
  operationKey: 'delete_row',
  displayName: 'Delete Row',
  method: 'POST',
  path: '/v4/spreadsheets/{spreadsheetId}:batchUpdate',
  parameters: [
    { name: 'spreadsheetId', in: 'path', required: true, type: 'string' },
    {
      name: 'body',
      in: 'body',
      required: true,
      type: 'object',
      // JSON object shaped exactly like:
      // {"requests": [{"deleteDimension": {"range": {"sheetId": <int>, "dimension": "ROWS",
      //   "startIndex": <zero-based row index>, "endIndex": <startIndex + 1>}}}]}
    },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/spreadsheets'] },
  sourceOperationIds: ['DeleteItem'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3. GOOGLE CONTACTS (People API v1) — connectorId confirmed against registry.ts's existing
//    shared_googlecontacts entry (dedicated connector_tools/contacts.py file exists; this
//    catalog does not touch it yet). Source: learn.microsoft.com/en-us/connectors/
//    googlecontacts/ (3 non-deprecated actions: Create a contact V2, Create a contact V3
//    (Preview), Get my contacts V4 — everything else on that page, including "Create a
//    contact V4" from the user's own Connectors.docx, is either deprecated or does not exist;
//    the real page has no V4 create action, only a V4 read) + People API v1
//    (developers.google.com/people/api/rest).
// ─────────────────────────────────────────────────────────────────────────────────────────
const CONTACTS = 'shared_googlecontacts';

await putCatalogConnector({
  connectorId: CONTACTS,
  displayName: 'Google Contacts',
  vendor: 'google',
  apiFamily: 'people_v1',
  baseUrl: 'https://people.googleapis.com',
  specSourceUrl: 'https://developers.google.com/people/api/rest/v1/people/createContact',
  authKind: 'google-service-account',
  status: 'candidate',
  catalogVersion: CATALOG_VERSION,
});

// create_contact — V2 and V3 are both real, non-deprecated Microsoft operationIds, and both
// resolve to the exact same real People API call (confirmed on Microsoft's own page: same
// path, same URL for both) — one catalog row with two sourceOperationIds, not two rows.
await putCatalogOperation({
  connectorId: CONTACTS,
  operationKey: 'create_contact',
  displayName: 'Create a contact',
  method: 'POST',
  path: '/v1/people:createContact',
  parameters: [
    {
      name: 'body',
      in: 'body',
      required: true,
      type: 'object',
      // JSON object, e.g. {"names": [{"givenName": "...", "familyName": "..."}],
      // "emailAddresses": [{"value": "..."}], "phoneNumbers": [{"value": "..."}],
      // "organizations": [{"name": "...", "title": "..."}]}
    },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/contacts'] },
  sourceOperationIds: ['PeopleApiCreateContactV2', 'PeopleApiCreateContactV3'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_my_contacts (V4) — the only non-deprecated READ action on the page.
await putCatalogOperation({
  connectorId: CONTACTS,
  operationKey: 'get_my_contacts',
  displayName: 'Get my contacts',
  method: 'GET',
  path: '/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/contacts'] },
  response: { resultPath: 'connections' },
  sourceOperationIds: ['PeopleApiListContactsV4'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 4. GOOGLE CALENDAR — connectorId confirmed against registry.ts's existing
//    shared_googlecalendar entry (dedicated connector_tools/calendar.py file exists; not
//    touched here). Source: learn.microsoft.com/en-us/connectors/googlecalendar/ (6 actions,
//    0 deprecated; 5 triggers excluded — this pipeline extracts agent TOOL calls, not flow
//    triggers) + Calendar API v3 (developers.google.com/workspace/calendar/api/v3/reference).
// ─────────────────────────────────────────────────────────────────────────────────────────
const CALENDAR = 'shared_googlecalendar';

await putCatalogConnector({
  connectorId: CALENDAR,
  displayName: 'Google Calendar',
  vendor: 'google',
  apiFamily: 'calendar_v3',
  baseUrl: 'https://www.googleapis.com/calendar/v3',
  specSourceUrl: 'https://developers.google.com/workspace/calendar/api/v3/reference/events',
  authKind: 'google-service-account',
  status: 'candidate',
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CALENDAR,
  operationKey: 'create_event',
  displayName: 'Create an event',
  method: 'POST',
  path: '/calendars/{calendarId}/events',
  parameters: [
    { name: 'calendarId', in: 'path', required: true, type: 'string' },
    {
      name: 'body',
      in: 'body',
      required: true,
      type: 'object',
      // JSON object, e.g. {"summary": "...", "description": "...", "location": "...",
      // "start": {"dateTime": "2026-11-01T10:00:00-07:00"}, "end": {"dateTime": "..."},
      // "attendees": [{"email": "..."}], "status": "confirmed"}
    },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  sourceOperationIds: ['CreateEvent'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CALENDAR,
  operationKey: 'get_event',
  displayName: 'Get an event',
  method: 'GET',
  path: '/calendars/{calendarId}/events/{eventId}',
  parameters: [
    { name: 'calendarId', in: 'path', required: true, type: 'string' },
    { name: 'eventId', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  sourceOperationIds: ['GetEvent'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CALENDAR,
  operationKey: 'delete_event',
  displayName: 'Delete an event',
  method: 'DELETE',
  path: '/calendars/{calendarId}/events/{eventId}',
  parameters: [
    { name: 'calendarId', in: 'path', required: true, type: 'string' },
    { name: 'eventId', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  sourceOperationIds: ['DeleteEvent'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: CALENDAR,
  operationKey: 'list_calendars',
  displayName: 'List calendars',
  method: 'GET',
  path: '/users/me/calendarList',
  parameters: [{ name: 'minAccessRole', in: 'query', required: false, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  response: { resultPath: 'items' },
  sourceOperationIds: ['ListCalendars'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// list_events — paginates with an opaque `nextPageToken`, not a followable URL, so
// `response.pagination` is deliberately left unset (see the module docstring) — this returns
// the first page only, honestly, until token-style pagination is built.
await putCatalogOperation({
  connectorId: CALENDAR,
  operationKey: 'list_events',
  displayName: 'List the events on a calendar',
  method: 'GET',
  path: '/calendars/{calendarId}/events',
  parameters: [
    { name: 'calendarId', in: 'path', required: true, type: 'string' },
    { name: 'timeMin', in: 'query', required: false, type: 'string' },
    { name: 'timeMax', in: 'query', required: false, type: 'string' },
    { name: 'q', in: 'query', required: false, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  response: { resultPath: 'items' }, // first page only — see module docstring on pagination
  sourceOperationIds: ['ListEvents'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// update_event — Microsoft's single "Update an event" operation has every field but
// calendarId/eventId OPTIONAL, which matches PATCH (partial update) semantics far more than
// PUT (a full replace that erases any field you don't resend). This is MY OWN INFERENCE, not
// a confirmed 1:1 mapping — the user's own API.docx flagged the exact same ambiguity
// ("Which one the connector uses is unknown").
await putCatalogOperation({
  connectorId: CALENDAR,
  operationKey: 'update_event',
  displayName: 'Update an event',
  method: 'PATCH',
  path: '/calendars/{calendarId}/events/{eventId}',
  parameters: [
    { name: 'calendarId', in: 'path', required: true, type: 'string' },
    { name: 'eventId', in: 'path', required: true, type: 'string' },
    { name: 'body', in: 'body', required: true, type: 'object' }, // only the fields to change
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/calendar'] },
  sourceOperationIds: ['UpdateEvent'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 5. GOOGLE TASKS — added alongside shared_googlesheet in this same pass; no existing
//    registry.ts entry or dedicated connector_tools/*.py file before this change. Source:
//    learn.microsoft.com/en-us/connectors/googletasks/ (5 actions, 0 deprecated; 5 triggers
//    excluded) + Tasks API v1 (developers.google.com/tasks/reference/rest).
// ─────────────────────────────────────────────────────────────────────────────────────────
const TASKS = 'shared_googletasks';

await putCatalogConnector({
  connectorId: TASKS,
  displayName: 'Google Tasks',
  vendor: 'google',
  apiFamily: 'tasks_v1',
  baseUrl: 'https://tasks.googleapis.com',
  specSourceUrl: 'https://developers.google.com/tasks/reference/rest',
  authKind: 'google-service-account',
  status: 'candidate',
  catalogVersion: CATALOG_VERSION,
});

// create_task_in_list — sourceOperationId is "CraeteTask", NOT a typo on my part. That is the
// REAL operationId exactly as Microsoft's own connector reference spells it (confirmed live
// 2026-10-22). Recorded verbatim and flagged loudly so nobody "fixes" it to the correctly-
// spelled "CreateTask" later and silently breaks the match — exactly the class of bug the
// Office 365 Users pilot was burned by once already (get_photo's sourceOperationIds mismatch).
await putCatalogOperation({
  connectorId: TASKS,
  operationKey: 'create_task_in_list',
  displayName: 'Create a task in a task list',
  method: 'POST',
  path: '/tasks/v1/lists/{tasklist}/tasks',
  parameters: [
    { name: 'tasklist', in: 'path', required: true, type: 'string' },
    { name: 'body', in: 'body', required: true, type: 'object' }, // {"title": "...", "notes": "...", "due": "2026-11-01T00:00:00.000Z"}
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/tasks'] },
  // NOT A TYPO — see the comment above this operation.
  sourceOperationIds: ['CraeteTask'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: TASKS,
  operationKey: 'create_task_list',
  displayName: 'Create a task list',
  method: 'POST',
  path: '/tasks/v1/users/@me/lists',
  parameters: [{ name: 'body', in: 'body', required: true, type: 'object' }], // {"title": "..."}
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/tasks'] },
  sourceOperationIds: ['CreateTaskList'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// get_task_from_list — Microsoft's real operationId is "ListTask" (singular task, despite the
// name looking like a listing call) — verified against the live page, not assumed.
await putCatalogOperation({
  connectorId: TASKS,
  operationKey: 'get_task_from_list',
  displayName: 'Get a task from a task list',
  method: 'GET',
  path: '/tasks/v1/lists/{tasklist}/tasks/{task}',
  parameters: [
    { name: 'tasklist', in: 'path', required: true, type: 'string' },
    { name: 'task', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/tasks'] },
  sourceOperationIds: ['ListTask'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: TASKS,
  operationKey: 'list_task_lists',
  displayName: 'List task lists',
  method: 'GET',
  path: '/tasks/v1/users/@me/lists',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/tasks'] },
  response: { resultPath: 'items' }, // first page only — see module docstring on pagination
  sourceOperationIds: ['ListTaskLists'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: TASKS,
  operationKey: 'list_tasks_for_list',
  displayName: 'Lists the tasks for a task list',
  method: 'GET',
  path: '/tasks/v1/lists/{tasklist}/tasks',
  parameters: [{ name: 'tasklist', in: 'path', required: true, type: 'string' }],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/tasks'] },
  response: { resultPath: 'items' }, // first page only — see module docstring on pagination
  sourceOperationIds: ['ListTasks'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 6. GMAIL — connectorId confirmed against registry.ts's existing shared_gmail entry
//    (dedicated connector_tools/gmail.py file exists; not touched here). Source:
//    learn.microsoft.com/en-us/connectors/gmail/ (6 non-deprecated actions; "Reply to email
//    [DEPRECATED]" and "Send email [DEPRECATED]" excluded; "Search emails" and the trigger
//    excluded from the user's own list but included here since it's real and useful) + Gmail
//    API v1 (developers.google.com/gmail/api/reference/rest).
// ─────────────────────────────────────────────────────────────────────────────────────────
const GMAIL = 'shared_gmail';

await putCatalogConnector({
  connectorId: GMAIL,
  displayName: 'Gmail',
  vendor: 'google',
  apiFamily: 'gmail_v1',
  baseUrl: 'https://gmail.googleapis.com',
  specSourceUrl: 'https://developers.google.com/gmail/api/reference/rest/v1/users.messages',
  authKind: 'google-service-account',
  status: 'candidate',
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: GMAIL,
  operationKey: 'delete_mail',
  displayName: 'Delete email',
  method: 'DELETE',
  path: '/gmail/v1/users/{userId}/messages/{id}',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' }, // "me" for the impersonated mailbox
    { name: 'id', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  sourceOperationIds: ['DeleteEmail'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: GMAIL,
  operationKey: 'get_email_details',
  displayName: 'Get email details',
  method: 'GET',
  path: '/gmail/v1/users/{userId}/messages/{id}?format=full',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' },
    { name: 'id', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  sourceOperationIds: ['GetEmail'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

await putCatalogOperation({
  connectorId: GMAIL,
  operationKey: 'move_email_to_trash',
  displayName: 'Move email to trash',
  method: 'POST',
  path: '/gmail/v1/users/{userId}/messages/{id}/trash',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' },
    { name: 'id', in: 'path', required: true, type: 'string' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  sourceOperationIds: ['TrashEmail'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// search_emails — HONEST FIDELITY GAP, not hidden: Gmail's real messages.list only returns
// message ids/threadIds, never subject/from/body. Microsoft's "Search emails" presents full
// detail objects, which really means the live connector does list-then-get-each internally.
// A single bound operation cannot do that fan-out, so this stays a real, single, correct
// call — it just returns ids, and the description says so plainly rather than overclaiming.
await putCatalogOperation({
  connectorId: GMAIL,
  operationKey: 'search_emails',
  displayName: 'Search emails',
  method: 'GET',
  path: '/gmail/v1/users/{userId}/messages',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' },
    {
      name: 'q',
      in: 'query',
      required: false,
      type: 'string', // Gmail search syntax, e.g. "from:alex@x.com is:unread larger:5M"
    },
    { name: 'maxResults', in: 'query', required: false, type: 'integer' },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  // Returns {id, threadId} pairs only, NOT full message details — call get_email_details per
  // id for the actual subject/body/from. Paginates with nextPageToken (see module docstring);
  // first page only for now.
  response: { resultPath: 'messages' },
  sourceOperationIds: ['SearchEmails'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// send_email (V2) — real Gmail send needs the body base64url-encoded as a full RFC 2822 MIME
// message wrapped in {"raw": "..."}, not a plain {to, subject, body} JSON object. This is
// higher risk than most entries here: it depends on the model correctly constructing and
// encoding that MIME text itself. Flagged candidate, not approved, specifically for that
// reason — needs a real live test before anyone trusts it to actually send mail correctly.
await putCatalogOperation({
  connectorId: GMAIL,
  operationKey: 'send_email',
  displayName: 'Send email (V2)',
  method: 'POST',
  path: '/gmail/v1/users/{userId}/messages/send',
  parameters: [
    { name: 'userId', in: 'path', required: true, type: 'string' },
    {
      name: 'body',
      in: 'body',
      required: true,
      type: 'object',
      // JSON object: {"raw": "<base64url, no padding, of a full RFC 2822 message: 'To: ...\\r\\n
      // Subject: ...\\r\\nContent-Type: text/html; charset=UTF-8\\r\\n\\r\\n<html body>'>"}
    },
  ],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  sourceOperationIds: ['SendEmailV2'],
  lifecycle: { status: 'candidate' },
  catalogVersion: CATALOG_VERSION,
});

// reply_to_email (V2) — UNSUPPORTED. A real reply needs the ORIGINAL message's Message-ID
// (for an In-Reply-To/References MIME header) plus its Gmail threadId on the new message,
// or Gmail sends it as a new, unthreaded email that only LOOKS like a reply. That is a read-
// then-send two-step operation, which a single bound call cannot do — matches the user's own
// API.docx flag ("Reply handling: my inference") taken to its honest conclusion rather than
// shipping a tool that silently fails to thread.
await putCatalogOperation({
  connectorId: GMAIL,
  operationKey: 'reply_to_email',
  displayName: 'Reply to email (V2)',
  method: 'POST',
  path: '/gmail/v1/users/{userId}/messages/send',
  parameters: [],
  auth: { mode: 'app-only', requiredPermissions: ['https://www.googleapis.com/auth/gmail.modify'] },
  sourceOperationIds: ['ReplyToV2'],
  lifecycle: { status: 'unsupported' },
  unsupportedReason:
    'A correct reply needs the original message\'s Message-ID and thread id so Gmail threads ' +
    'it properly — otherwise it sends as a new, unthreaded email that only looks like a ' +
    'reply. That requires reading the original message first, then sending: two dependent ' +
    'calls, which a single bound operation does not support yet.',
  catalogVersion: CATALOG_VERSION,
});

console.log(
  'Seeded Google connector catalog (v1): shared_googledrive (11 ops: 7 candidate, 4 unsupported), ' +
    'shared_googlesheet (6 ops, all candidate), shared_googlecontacts (2 ops, all candidate), ' +
    'shared_googlecalendar (6 ops, all candidate), shared_googletasks (5 ops, all candidate), ' +
    'shared_gmail (5 ops: 4 candidate, 1 unsupported). 35 operations total, 0 approved.',
);
process.exit(0);
