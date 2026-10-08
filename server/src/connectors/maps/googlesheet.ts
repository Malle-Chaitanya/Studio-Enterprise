import type { OperationMapEntry, MappedStep } from '../operationMap.js';
import { driveFileOperations } from './googledrive.js';

/**
 * shared_googlesheet -> Google Sheets v4, plus Google Drive v3 for its file half.
 *
 * TWO VENDOR APIS, ONE CONNECTOR. 25 of this connector's 39 operations are the standard
 * Power Platform file surface (`/datasets/default/files/...`) and are served by DRIVE, not
 * Sheets; only the 14 table operations are Sheets. That is why a map entry names the API it
 * targets rather than inheriting the connector's one resolved surface — see `bindWithMap`.
 *
 * THE TABLE ABSTRACTION. Power Platform models a spreadsheet as a dataset of tables of
 * items, so a worksheet is a "table" and a row is an "item":
 *
 *     dataset   the spreadsheet id     ->  spreadsheetId
 *     table     the worksheet name     ->  an A1 range naming that sheet
 *     item      a row                  ->  no stable equivalent (see below)
 *
 * ROWS ARE WHERE THIS STOPS. The connector addresses a row by an opaque key it maintains
 * itself, not by row number. Sheets has no such concept, so GetItem / PatchItem /
 * DeleteItem cannot be mapped: any guess — treating the key as a row index being the
 * obvious one — reads or OVERWRITES A DIFFERENT ROW and returns 200 while doing it. They
 * are declared unmappable rather than approximated.
 */

function sheets(operationId: string, steps: MappedStep[], notes?: string[]): OperationMapEntry {
  return { connectorId: 'shared_googlesheet', operationId, api: 'sheets', steps, notes, provenance: 'drafted' };
}

/** Power Platform exposes each table operation twice — `/datasets/{d}/tables/{t}` and the
 *  OData spelling `/datasets({d})/tables({t})`. Same operation, one mapping. */
function withODataAlias(e: OperationMapEntry): OperationMapEntry[] {
  return [e, { ...e, operationId: `ODataStyle${e.operationId}` }];
}

const NOTE_NO_ODATA =
  "The connector's $filter/$orderby/$top/$skip have no Sheets equivalent — Sheets v4 returns a "
  + 'whole range with no server-side query. The full sheet comes back, and any narrowing the '
  + 'original agent relied on is gone.';
const NOTE_HEADER_ROW =
  'Sheets returns raw rows including the header as the first row, where the connector returned '
  + 'objects keyed by column name. Callers that referenced column names need adjusting.';

export const GOOGLE_SHEET_MAP: OperationMapEntry[] = [
  // The file half — the real Google Drive API, one definition shared with googledrive.
  ...driveFileOperations('shared_googlesheet'),

  // The table half — Sheets v4.
  ...withODataAlias(sheets('GetTables', [{
    vendorMethodId: 'sheets.spreadsheets.get',
    parameters: [{ to: 'spreadsheetId', in: 'path', template: '{dataset}' }],
  }], [
    'Returns the whole spreadsheet with its sheet list, where the connector returned only table '
    + 'names; the caller reads sheets[].properties.title.',
  ])),

  ...withODataAlias(sheets('GetTable', [{
    vendorMethodId: 'sheets.spreadsheets.get',
    parameters: [
      { to: 'spreadsheetId', in: 'path', template: '{dataset}' },
      { to: 'ranges', in: 'query', template: '{table}' },
    ],
  }], [NOTE_HEADER_ROW])),

  ...withODataAlias(sheets('GetItems', [{
    vendorMethodId: 'sheets.spreadsheets.values.get',
    parameters: [
      { to: 'spreadsheetId', in: 'path', template: '{dataset}' },
      // A bare sheet name IS a valid A1 range meaning the whole sheet. A name containing a
      // space must be quoted in A1 notation, which this template cannot know — recorded as
      // a note rather than silently mangled.
      { to: 'range', in: 'path', template: '{table}' },
    ],
  }], [
    NOTE_NO_ODATA,
    NOTE_HEADER_ROW,
    'A worksheet name containing a space or a quote needs A1 quoting this mapping does not apply.',
  ])),

  ...withODataAlias(sheets('PostItem', [{
    vendorMethodId: 'sheets.spreadsheets.values.append',
    parameters: [
      { to: 'spreadsheetId', in: 'path', template: '{dataset}' },
      { to: 'range', in: 'path', template: '{table}' },
      { to: 'valueInputOption', in: 'query', template: 'USER_ENTERED' },
    ],
    // Sheets appends a LIST of rows, each row a list of cell values. The connector sends one
    // row as an object keyed by column; `{item}` carries it through as the single row.
    bodyTemplate: '{"values": [{item}]}',
  }], [
    'The connector posts an object keyed by column name; Sheets takes a positional row, so the '
    + "destination sheet's column order decides where values land.",
  ])),
];

export const GOOGLE_SHEET_UNMAPPABLE: Record<string, string> = {
  GetItem: 'The connector addresses a row by an opaque key it maintains itself. Sheets has no equivalent; treating it as a row index would read a DIFFERENT row and return 200.',
  PatchItem: 'Row identity (see GetItem). A guess here overwrites the wrong row silently.',
  DeleteItem: 'Row identity (see GetItem), and Sheets deletes rows via batchUpdate DeleteDimension, not the values API.',
  ODataStyleGetItem: 'Row identity (see GetItem).',
  ODataStylePatchItem: 'Row identity (see GetItem).',
  ODataStyleDeleteItem: 'Row identity (see GetItem).',
  CreateFile: "Drive uploads content to a different host (upload/drive/v3) this build does not yet read from Discovery.",
  CreateFile_Old: "Drive uploads content to a different host (upload/drive/v3) this build does not yet read from Discovery.",
  UpdateFile: "Content update uses Drive's upload host, not yet captured.",
  UpdateFile_Old: "Content update uses Drive's upload host, not yet captured.",
  ExtractFolderV2: 'Unpacks an archive server-side. No vendor API does this — Power Platform does the work itself.',
  ExtractFolder_Old: 'Unpacks an archive server-side. No vendor API does this.',
  GetDataSets: 'Power Platform metadata about the connection itself, not a vendor resource.',
  GetDataSetsMetadata: 'Power Platform metadata about the connection itself, not a vendor resource.',
};
