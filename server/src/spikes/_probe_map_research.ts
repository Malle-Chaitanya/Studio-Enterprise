/** Side-by-side research input for drafting operation-map entries: the connector's real
 *  operations with their arguments, and the vendor API's real methods with theirs. Dumps
 *  only schema, never data. Throwaway diagnostic. */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { resolveVendorApiSurface } from '../connectors/vendorSpec.js';

const cid = process.env.CSGE_CONNECTORS ?? 'shared_googledrive';
const ctx: CaptureContext = {
  tenantId: process.env.CSGE_TENANT_ID!,
  environmentId: process.env.CSGE_ENVIRONMENT_ID!,
  scope: `ms-${process.env.CSGE_TENANT_ID}`,
};
const index = await resolveOpIndex(cid, ctx);
if (!index) { console.error('no index'); process.exit(1); }
const surface = await resolveVendorApiSurface(cid, index);

const out: string[] = [];
out.push(`### ${cid} — ${Object.keys(index.operations).length} operations`);
for (const [id, op] of Object.entries(index.operations)) {
  const args = op.parameters.map((p) => `${p.name}:${p.in}${p.required ? '*' : ''}`).join(' ');
  out.push(`${id}\t${op.method}\t${op.path.replace(/^\/\{connectionId\}/, '')}\t${args}`);
}
out.push('');
out.push(`### vendor api: ${surface?.api ?? 'UNRESOLVED'} — ${surface?.methods.length ?? 0} methods`);
for (const m of surface?.methods ?? []) {
  const ps = (m.parameters ?? []).map((p) => `${p.name}:${p.in}${p.required ? '*' : ''}`).join(' ');
  out.push(`${m.id}\t${m.httpMethod}\t${m.url}\t${ps}${m.hasBody ? '\tBODY' : ''}`);
}
out.push('');
out.push(`### api-wide parameters: ${(surface?.commonParameters ?? []).map((p) => p.name).join(' ')}`);
const text = out.join('\n');
const file = process.argv[2] ?? `${cid}_research.txt`;
writeFileSync(file, text);
console.log(text.split('\n').slice(0, 55).join('\n'));
console.log(`\n... full dump -> ${file}`);
