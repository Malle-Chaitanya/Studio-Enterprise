import { indexOperationMap } from '../operationMap.js';
import { GOOGLE_DRIVE_MAP, GOOGLE_DRIVE_UNMAPPABLE } from './googledrive.js';
import { GOOGLE_SHEET_MAP, GOOGLE_SHEET_UNMAPPABLE } from './googlesheet.js';
import { GOOGLE_CONTACTS_MAP, GOOGLE_CONTACTS_UNMAPPABLE } from './googlecontacts.js';

/**
 * Every stated connector->vendor equivalence, in one index.
 *
 * Checked into the repo rather than seeded into Mongo: these are claims about two PUBLIC
 * APIs, identical for every customer, and they must be reviewable in a diff. A mapping that
 * can change without a commit is a mapping nobody can audit after it returns the wrong rows.
 */
export const OPERATION_MAP = indexOperationMap([
  ...GOOGLE_DRIVE_MAP,
  ...GOOGLE_SHEET_MAP,
  ...GOOGLE_CONTACTS_MAP,
]);

/**
 * Why an operation will NOT migrate, per connector.
 *
 * Exported beside the map, not buried in its own module, because the two are one fact seen
 * from two sides: an operation is mapped or it is explained, never both and never neither.
 * They drifted exactly once -- UpdateFile stayed on this list after the upload host landed
 * and it began binding -- which would have had the report give a confident false reason for
 * an operation that migrated fine. `operationMapIntegrity.test.ts` now fails on that.
 */
export const OPERATION_UNMAPPABLE: Record<string, Record<string, string>> = {
  shared_googledrive: GOOGLE_DRIVE_UNMAPPABLE,
  shared_googlesheet: GOOGLE_SHEET_UNMAPPABLE,
  shared_googlecontacts: GOOGLE_CONTACTS_UNMAPPABLE,
};
