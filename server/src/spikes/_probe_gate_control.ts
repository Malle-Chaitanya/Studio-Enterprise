/** Negative control: feed the live structural gate entries that are deliberately wrong in
 *  the ways a careless draft would be, and confirm it refuses them. Throwaway diagnostic. */
import 'dotenv/config';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { resolveVendorApiSurface } from '../connectors/vendorSpec.js';
import { verifyMapEntry, type OperationMapEntry } from '../connectors/operationMap.js';

const ctx: CaptureContext = {
  tenantId: process.env.CSGE_TENANT_ID!,
  environmentId: process.env.CSGE_ENVIRONMENT_ID!,
  scope: `ms-${process.env.CSGE_TENANT_ID}`,
};
const index = (await resolveOpIndex('shared_googledrive', ctx))!;
const surface = (await resolveVendorApiSurface('shared_googledrive', index))!;

const base = (steps: any): OperationMapEntry =>
  ({ connectorId: 'shared_googledrive', operationId: 'GetFileMetadata', api: 'drive', steps, provenance: 'drafted' });

const CASES: Array<[string, OperationMapEntry]> = [
  ['plausible method that is not published', base([{ vendorMethodId: 'drive.files.fetch', parameters: [{ to: 'fileId', in: 'path', template: '{id}' }] }])],
  ['vendor arg name instead of connector arg', base([{ vendorMethodId: 'drive.files.get', parameters: [{ to: 'fileId', in: 'path', template: '{fileId}' }] }])],
  ['required fileId never filled',            base([{ vendorMethodId: 'drive.files.get', parameters: [{ to: 'supportsAllDrives', in: 'query', template: 'true' }] }])],
  ['invented parameter',                      base([{ vendorMethodId: 'drive.files.get', parameters: [{ to: 'fileId', in: 'path', template: '{id}' }, { to: 'includeContent', in: 'query', template: 'true' }] }])],
  ['alt outside declared enum',               base([{ vendorMethodId: 'drive.files.get', parameters: [{ to: 'fileId', in: 'path', template: '{id}' }, { to: 'alt', in: 'query', template: 'bytes' }] }])],
];

let caught = 0;
for (const [label, e] of CASES) {
  const r = verifyMapEntry(e, surface, index);
  const verdict = r.status === 'rejected' ? `REFUSED  [${r.problems.map((p) => p.kind).join(', ')}]` : `*** ACCEPTED (${r.status}) ***`;
  if (r.status === 'rejected') caught++;
  console.log(`${label.padEnd(42)} ${verdict}`);
}
console.log(`\ngate refused ${caught}/${CASES.length} deliberately-wrong entries`);
process.exit(caught === CASES.length ? 0 : 1);
