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
 * WHAT IS STILL MISSING, stated rather than faked: Drive splits content upload onto a
 * different host (`https://www.googleapis.com/upload/drive/v3/...`), which Discovery
 * describes under `mediaUpload` and `flatten()` does not yet capture. Until it does,
 * CreateFile / CreateFileV2 / UpdateFile / AppendFile cannot be expressed and are absent
 * here rather than guessed at. Download is fine — that is `alt=media` on the normal host.
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
      { to: 'parents', in: 'body', template: '{destination}' },
      ALL_DRIVES,
    ],
  }], [
    'The connector\'s `overwrite` argument has no Drive equivalent — Drive always creates a new '
    + 'file, so a copy onto an existing name yields two files rather than replacing one.',
    'Source and destination are connector ids/paths; where the destination is a PATH rather than a '
    + 'folder id this entry is wrong and needs the path-resolution recipe.',
  ])),

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
];

/**
 * Operations deliberately NOT mapped, with the reason. Present so the report can say WHY an
 * operation will not migrate instead of leaving it indistinguishable from one nobody looked
 * at — the difference between a known limit and an oversight.
 */
export const GOOGLE_DRIVE_UNMAPPABLE: Record<string, string> = {
  CreateFile: 'Drive uploads content to a different host (upload/drive/v3) that this build does not yet read from Discovery.',
  CreateFileV2: 'Drive uploads content to a different host (upload/drive/v3) that this build does not yet read from Discovery.',
  CreateFile_Old: 'Drive uploads content to a different host (upload/drive/v3) that this build does not yet read from Discovery.',
  UpdateFile: 'Content update uses Drive\'s upload host, not yet captured.',
  UpdateFile_Old: 'Content update uses Drive\'s upload host, not yet captured.',
  AppendFile: 'Drive has no append; it would be a read-modify-write through the upload host.',
  CreateFolder: 'Takes a folder PATH, which Drive cannot resolve; needs the path recipe plus a create.',
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
