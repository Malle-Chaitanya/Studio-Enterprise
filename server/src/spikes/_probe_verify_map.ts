/** Run the structural gate over a connector's drafted map entries, against the vendor's
 *  real published API and the connector as the customer's environment declares it.
 *  Reports only. Throwaway diagnostic. */
import 'dotenv/config';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { resolveVendorApiSurface } from '../connectors/vendorSpec.js';
import { verifyMapEntry } from '../connectors/operationMap.js';
import { GOOGLE_DRIVE_MAP, GOOGLE_DRIVE_UNMAPPABLE } from '../connectors/maps/googledrive.js';

const cid = 'shared_googledrive';
const ctx: CaptureContext = {
  tenantId: process.env.CSGE_TENANT_ID!,
  environmentId: process.env.CSGE_ENVIRONMENT_ID!,
  scope: `ms-${process.env.CSGE_TENANT_ID}`,
};
const index = await resolveOpIndex(cid, ctx);
if (!index) { console.error('no index'); process.exit(1); }
const surface = await resolveVendorApiSurface(cid, index);
if (!surface) { console.error('no vendor surface'); process.exit(1); }

let ok = 0, bad = 0, skip = 0;
for (const e of GOOGLE_DRIVE_MAP) {
  const r = verifyMapEntry(e, surface, index);
  if (r.status === 'verified') { ok++; console.log(`PASS   ${e.operationId}`); }
  else if (r.status === 'cannot-verify') { skip++; console.log(`SKIP   ${e.operationId}  ${r.reason}`); }
  else {
    bad++;
    console.log(`REJECT ${e.operationId}`);
    for (const p of r.problems) console.log(`         [${p.kind}] ${p.detail}`);
  }
}

const total = Object.keys(index.operations).length;
const mapped = new Set(GOOGLE_DRIVE_MAP.map((e) => e.operationId));
const declaredUnmappable = new Set(Object.keys(GOOGLE_DRIVE_UNMAPPABLE));
const unaccounted = Object.keys(index.operations).filter((o) => !mapped.has(o) && !declaredUnmappable.has(o));

console.log(`\nstructural gate: ${ok} pass, ${bad} reject, ${skip} cannot-verify`);
console.log(`coverage: ${mapped.size} mapped + ${declaredUnmappable.size} declared-unmappable = ${mapped.size + declaredUnmappable.size} of ${total} operations`);
if (unaccounted.length) console.log(`UNACCOUNTED (${unaccounted.length}): ${unaccounted.join(', ')}`);
else console.log('every operation is either mapped or has a stated reason.');
process.exit(0);
