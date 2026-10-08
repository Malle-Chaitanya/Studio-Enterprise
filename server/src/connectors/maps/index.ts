import { indexOperationMap } from '../operationMap.js';
import { GOOGLE_DRIVE_MAP } from './googledrive.js';
import { GOOGLE_SHEET_MAP } from './googlesheet.js';
import { GOOGLE_CONTACTS_MAP } from './googlecontacts.js';

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
