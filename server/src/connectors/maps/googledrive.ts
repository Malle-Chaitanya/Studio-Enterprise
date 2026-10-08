import type { OperationMapEntry, MappedStep } from '../operationMap.js';

/**
 * shared_googledrive -> Google Drive v3.
 *
 * Drafted from measured schema on both sides (`_probe_map_research.ts`), not from memory:
 * the connector's 42 operations as the customer's own environment declares them, and the
 * Drive v3 Discovery document's 64 methods with their declared parameters.
 *
 * WHAT THE 42 ACTUALLY ARE. The headline number badly overstates the work, in both
 * directions, and the shape is worth stating because it recurs on every Power Platform file
 * connector:
 *
 *   17  distinct file/folder operations     the real surface
 *   11  `_Old` twins (/api/blob/...)        same semantics, legacy path, same mapping
 *   14  dataset/table operations            Power Platform's TABLE interface, which the
 *                                           file-connector template carries on every
 *                                           connector whether or not the vendor has tables.
 *                                           Drive has no table concept at all.
 *
 * So the ceiling here is 28 operations (17 + 11 aliases), not 42, and the 14 table
 * operations are not a gap we can close — there is nothing on the other side.
 *
 * WHAT IS STILL MISSING, stated rather than faked: one capability, not a list of
 * operations. Drive splits content upload onto a different host
 * (`https://www.googleapis.com/upload/drive/v3/...`); `flatten()` now reads that from
 * Discovery's `mediaUpload`, so CreateFileV2 and UpdateFile are expressed here as two calls
 * (metadata, then bytes). What remains unexpressible is LOCAL COMPUTATION: ExtractFolderV2
 * unpacks an archive, which is Power Platform doing work no vendor endpoint does. A map
 * expresses an API CALL; it cannot express a loop, a filter or an unzip. That is the one
 * gap left on this connector, and closing it needs a local step kind, not another entry.
 *
 * Every entry is `drafted` until a gate promotes it. The structural gate runs offline; the
 * behavioral gate diffs against the live connector. Neither has run on these yet.
 */

/** Drive's defaults differ from the connector's in two ways that silently change results,
 *  so every list/get carries them rather than relying on a default:
 *
 *    trashed            Drive INCLUDES deleted files in a query; the connector excludes
 *                       them. Omitting `trashed = false` returns rows Copilot never showed.
 *    supportsAllDrives  defaults FALSE, so anything on a shared drive 404s even though the
 *                       connector found it. This is the single most likely silent
 *                       difference on a real customer tenant.
 */
const ALL_DRIVES = { to: 'supportsAllDrives', in: 'query' as const, template: 'true' };
const FROM_ALL_DRIVES = { to: 'includeItemsFromAllDrives', in: 'query' as const, template: 'true' };

const NOTE_SHARED_DRIVES =
  'Shared-drive items are included explicitly; Drive would otherwise omit them where the connector did not.';
const NOTE_PATH_LOOKUP =
  'Drive v3 has no path lookup. Resolved by searching the file NAME, so a path like /A/report.docx '
  + 'matches report.docx in any folder. Where names repeat, the first match wins and may not be the '
  + 'file Copilot returned.';
const NOTE_PAGINATION =
  'Drive pages at 100 items by default where the connector returned the full set; callers must follow nextPageToken.';

function entry(
  operationId: string,
  steps: MappedStep[],
  notes?: string[],
): OperationMapEntry {
  return { connectorId: 'shared_googledrive', operationId, api: 'drive', steps, notes, provenance: 'drafted' };
}

/**
 * The `_Old` operations are the same operation on the connector's retired `/api/blob/`
 * paths. Microsoft kept both so existing flows did not break. One mapping, two ids — stated
 * as an alias rather than copied, because two copies of one fact is how this codebase's
 * recurring bug class starts.
 */
function withLegacyAlias(e: OperationMapEntry): OperationMapEntry[] {
  return [e, { ...e, operationId: `${e.operationId}_Old` }];
}

export const GOOGLE_DRIVE_MAP: OperationMapEntry[] = [
  // ---- direct, single call -------------------------------------------------------------
  ...withLegacyAlias(entry('GetFileMetadata', [{
    vendorMethodId: 'drive.files.get',
    parameters: [{ to: 'fileId', in: 'path', template: '{id}' }, ALL_DRIVES],
  }], [NOTE_SHARED_DRIVES])),

  ...withLegacyAlias(entry('GetFileContent', [{
    vendorMethodId: 'drive.files.get',
    parameters: [
      { to: 'fileId', in: 'path', template: '{id}' },
      // `alt=media` is Drive's way of asking for bytes instead of metadata. It is an
      // API-WIDE parameter, not one `files.get` declares, which is why the verifier has to
      // know about Discovery's top-level block.
      { to: 'alt', in: 'query', template: 'media' },
      ALL_DRIVES,
    ],
  }], [
    NOTE_SHARED_DRIVES,
    'Google Workspace documents (Docs/Sheets/Slides) cannot be downloaded with alt=media and need '
    + 'drive.files.export with a target mimeType; this entry returns an error for them where the '
    + 'connector returned a converted file.',
  ])),

  ...withLegacyAlias(entry('DeleteFile', [{
    vendorMethodId: 'drive.files.delete',
    parameters: [{ to: 'fileId', in: 'path', template: '{id}' }, ALL_DRIVES],
  }], [
    'Drive deletes permanently; the connector moved the file to trash. Not reversible by the user.',
  ])),

  ...withLegacyAlias(entry('CopyFile', [{
    vendorMethodId: 'drive.files.copy',
    parameters: [
      { to: 'fileId', in: 'path', template: '{source}' },
      ALL_DRIVES,
    ],
    // Drive wants a parent ARRAY where the connector passes one destination. The
    // placeholder is unquoted: it is replaced by the JSON encoding of the argument, so a
    // destination of `abc` becomes `["abc"]` and not `[abc]`.
    bodyTemplate: '{"parents": [{destination}]}',
  }], [
    'The connector\'s `overwrite` argument has no Drive equivalent — Drive always creates a new '
    + 'file, so a copy onto an existing name yields two files rather than replacing one.',
    'Source and destination are connector ids/paths; where the destination is a PATH rather than a '
    + 'folder id this entry is wrong and needs the path-resolution recipe.',
  ])),

  // ---- content upload: same method, different host --------------------------------------
  ...withLegacyAlias(entry('UpdateFile', [{
    vendorMethodId: 'drive.files.update',
    // Drive reads a file at /drive/v3/files/{id} and writes its bytes at
    // /upload/drive/v3/files/{id}. Discovery publishes the second only under `mediaUpload`.
    useUploadUrl: true,
    parameters: [
      { to: 'fileId', in: 'path', template: '{id}' },
      { to: 'uploadType', in: 'query', template: 'media' },
      ALL_DRIVES,
    ],
    // The body is the file's bytes, forwarded untouched. Encoding it as JSON would upload
    // the quoted, escaped TEXT of the file instead of the file.
    forwardBodyFrom: 'body',
  }], [
    'Replaces the file\'s content. uploadType=media sends bytes only, so the file keeps its '
    + 'existing name, parents and mime type — the connector could change metadata in the same call.',
  ])),

  entry('CreateFileV2', [
    // Drive separates a file's METADATA from its bytes. A single multipart upload can carry
    // both, but multipart is not a JSON body and this build cannot express it — two calls
    // can, and say plainly what they do.
    {
      vendorMethodId: 'drive.files.create',
      parameters: [ALL_DRIVES],
      bodyTemplate: '{"name": {name}, "parents": [{folderId}]}',
      capture: { fid: 'id' },
    },
    {
      vendorMethodId: 'drive.files.update',
      useUploadUrl: true,
      parameters: [
        { to: 'fileId', in: 'path', template: '{$fid}' },
        { to: 'uploadType', in: 'query', template: 'media' },
        ALL_DRIVES,
      ],
      forwardBodyFrom: 'body',
    },
  ], [
    'Created as two calls — metadata, then content. If the second fails the file exists and is '
    + 'empty, where the connector either created it whole or not at all.',
    'Drive infers the mime type from the content; the connector took it from the file name.',
  ]),

  // ---- folder listings -----------------------------------------------------------------
  ...withLegacyAlias(entry('ListFolder', [{
    vendorMethodId: 'drive.files.list',
    parameters: [
      { to: 'q', in: 'query', template: "'{id}' in parents and trashed = false" },
      ALL_DRIVES,
      FROM_ALL_DRIVES,
    ],
  }], [NOTE_SHARED_DRIVES, NOTE_PAGINATION])),

  ...withLegacyAlias(entry('ListRootFolder', [{
    vendorMethodId: 'drive.files.list',
    parameters: [
      { to: 'q', in: 'query', template: "'root' in parents and trashed = false" },
      ALL_DRIVES,
      FROM_ALL_DRIVES,
    ],
  }], [NOTE_PAGINATION])),

  entry('ListAllRootFolders', [{
    vendorMethodId: 'drive.drives.list',
    parameters: [],
  }], [
    'Maps to the SHARED DRIVES list, which is what the connector surfaces here. A user with no '
    + 'shared drives gets an empty list where the connector may have shown My Drive.',
  ]),

  // ---- path-based: no single Drive call exists -----------------------------------------
  ...withLegacyAlias(entry('GetFileMetadataByPath', [
    {
      vendorMethodId: 'drive.files.list',
      parameters: [
        { to: 'q', in: 'query', template: "name = '{path}' and trashed = false" },
        ALL_DRIVES,
        FROM_ALL_DRIVES,
      ],
      capture: { fid: 'files[0].id' },
    },
    {
      vendorMethodId: 'drive.files.get',
      parameters: [{ to: 'fileId', in: 'path', template: '{$fid}' }, ALL_DRIVES],
    },
  ], [NOTE_PATH_LOOKUP])),

  ...withLegacyAlias(entry('GetFileContentByPath', [
    {
      vendorMethodId: 'drive.files.list',
      parameters: [
        { to: 'q', in: 'query', template: "name = '{path}' and trashed = false" },
        ALL_DRIVES,
        FROM_ALL_DRIVES,
      ],
      capture: { fid: 'files[0].id' },
    },
    {
      vendorMethodId: 'drive.files.get',
      parameters: [
        { to: 'fileId', in: 'path', template: '{$fid}' },
        { to: 'alt', in: 'query', template: 'media' },
        ALL_DRIVES,
      ],
    },
  ], [NOTE_PATH_LOOKUP])),

  // A folder is an ordinary file carrying Drive's folder mime type, so this is the path
  // recipe above plus one create. It stopped being unmappable the moment that recipe
  // existed -- no new capability was needed, only noticing.
  entry('CreateFolder', [
    {
      vendorMethodId: 'drive.files.list',
      parameters: [
        { to: 'q', in: 'query', template: "name = '{folderPath}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" },
        ALL_DRIVES,
        FROM_ALL_DRIVES,
      ],
      capture: { pid: 'files[0].id' },
    },
    {
      vendorMethodId: 'drive.files.create',
      parameters: [ALL_DRIVES],
      bodyTemplate: '{"name": {name}, "mimeType": "application/vnd.google-apps.folder", "parents": [{$pid}]}',
    },
  ], [
    NOTE_PATH_LOOKUP,
    'The parent is resolved by searching for a FOLDER of that name, so only the last segment '
    + 'of a nested folderPath is honoured.',
    'Creating at the drive root does not work: the parent lookup finds nothing, and the '
    + 'operation stops rather than silently creating the folder somewhere else.',
  ]),

  // The old CreateFile addresses its parent by PATH where CreateFileV2 takes a folder id, so
  // it is CreateFolder's parent lookup followed by CreateFileV2's two calls. Three steps, no
  // capability this build did not already have -- it was listed unmappable on the strength of
  // an upload-host limitation that stopped being true.
  ...withLegacyAlias(entry('CreateFile', [
    {
      vendorMethodId: 'drive.files.list',
      parameters: [
        { to: 'q', in: 'query', template: "name = '{folderPath}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" },
        ALL_DRIVES,
        FROM_ALL_DRIVES,
      ],
      capture: { pid: 'files[0].id' },
    },
    {
      vendorMethodId: 'drive.files.create',
      parameters: [ALL_DRIVES],
      bodyTemplate: '{"name": {name}, "parents": [{$pid}]}',
      capture: { fid: 'id' },
    },
    {
      vendorMethodId: 'drive.files.update',
      useUploadUrl: true,
      parameters: [
        { to: 'fileId', in: 'path', template: '{$fid}' },
        { to: 'uploadType', in: 'query', template: 'media' },
        ALL_DRIVES,
      ],
      forwardBodyFrom: 'body',
    },
  ], [
    NOTE_PATH_LOOKUP,
    'Three calls where the connector made one. A failure after the second leaves an empty file '
    + 'behind, which the connector would never have created.',
    'Creating at the drive root does not work: the parent lookup finds nothing and the operation '
    + 'stops.',
  ])),
];

/**
 * Operations deliberately NOT mapped, with the reason. Present so the report can say WHY an
 * operation will not migrate instead of leaving it indistinguishable from one nobody looked
 * at — the difference between a known limit and an oversight.
 */
export const GOOGLE_DRIVE_UNMAPPABLE: Record<string, string> = {
  AppendFile: 'Drive has no append; it would be a read-modify-write through the upload host.',
  ExtractFolderV2: 'Unpacks an archive server-side. Drive has no equivalent — this is Power Platform doing the work, not the vendor.',
  ExtractFolder_Old: 'Unpacks an archive server-side. Drive has no equivalent.',
  GetDataSets: 'Power Platform metadata about the connection itself, not a Drive resource.',
  GetDataSetsMetadata: 'Power Platform metadata about the connection itself, not a Drive resource.',
  GetTable: 'Power Platform table interface. Drive has no table concept.',
  GetTables: 'Power Platform table interface. Drive has no table concept.',
  GetItem: 'Power Platform table interface. Drive has no table concept.',
  GetItems: 'Power Platform table interface. Drive has no table concept.',
  PostItem: 'Power Platform table interface. Drive has no table concept.',
  PatchItem: 'Power Platform table interface. Drive has no table concept.',
  DeleteItem: 'Power Platform table interface. Drive has no table concept.',
  ODataStyleGetTable: 'Power Platform table interface. Drive has no table concept.',
  ODataStyleGetTables: 'Power Platform table interface. Drive has no table concept.',
  ODataStyleGetItem: 'Power Platform table interface. Drive has no table concept.',
  ODataStyleGetItems: 'Power Platform table interface. Drive has no table concept.',
  ODataStylePostItem: 'Power Platform table interface. Drive has no table concept.',
  ODataStylePatchItem: 'Power Platform table interface. Drive has no table concept.',
  ODataStyleDeleteItem: 'Power Platform table interface. Drive has no table concept.',
};

/**
 * The same Drive file operations, for ANOTHER connector that carries them.
 *
 * Every Power Platform file connector inherits the same `/datasets/default/...` surface from
 * the template, so `shared_googlesheet` ships 25 of these alongside its table operations —
 * all backed by the real Google Drive API, exactly as here. Re-keying the one definition is
 * the point: a second copy would drift from this one, and the two would come to disagree
 * about `trashed` or `supportsAllDrives` without anything failing.
 *
 * An entry for an operation the target connector does not declare is harmless — verification
 * reports `cannot-verify` and the binder falls through.
 */
export function driveFileOperations(connectorId: string): OperationMapEntry[] {
  if (connectorId === 'shared_googledrive') return GOOGLE_DRIVE_MAP;
  return GOOGLE_DRIVE_MAP.map((e) => ({ ...e, connectorId }));
}
