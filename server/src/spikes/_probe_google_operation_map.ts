/**
 * EVERY Google connector a customer has, EVERY operation, through the PRODUCT's own path.
 *
 * WHY PER OPERATION. Every Google number before this was per CONNECTOR, from 3 sample paths,
 * and that granularity is a lie for any connector that is not uniform. shared_googlecontacts
 * proved it live: 12 operations, 4 on GData (retired 2022) and 5 on the real People API. A
 * connector-level verdict is wrong for one half whichever way it goes — refuse and working
 * operations are dropped, bind and tools 404.
 *
 * WHY IT CALLS PRODUCTION CODE. The first version of this probe read Google Discovery itself
 * and matched paths itself — a second implementation of exactly what `vendorSpec.ts` and
 * `bindOperation()` do. Two implementations of one fact is the bug class this repo keeps
 * paying for, and here it would be worse than usual: the probe's job is to tell you what the
 * migration WILL do, so any divergence makes it confidently wrong. It now calls
 * `resolveVendorApiSurface` + `bindOperation` and reports what they say.
 *
 *   CSGE_TENANT_ID=<entra tenant guid> \
 *   CSGE_ENV_URL=https://orgNNNN.crm.dynamics.com \
 *   CSGE_ENVIRONMENT_ID=<power platform environment guid> \
 *     npx tsx src/spikes/_probe_google_operation_map.ts [--json out.json]
 *
 * Reports only. Creates nothing, binds nothing, deploys nothing.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { resolveVendorApiSurface } from '../connectors/vendorSpec.js';
import { bindOperation } from '../connectors/operationBinding.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `${name} is not set. This probe reports on a CUSTOMER's environment and must be told ` +
      'which one; it has no default, deliberately. See the header for the three variables.',
    );
    process.exit(2);
  }
  return v;
}
const TENANT_ID = requireEnv('CSGE_TENANT_ID');
const ENVIRONMENT_ID = requireEnv('CSGE_ENVIRONMENT_ID');
requireEnv('CSGE_ENV_URL'); // asserted for parity with the other probes; capture needs the env id
const ctx: CaptureContext = { tenantId: TENANT_ID, environmentId: ENVIRONMENT_ID, scope: `ms-${TENANT_ID}` };

/** The Google connectors Copilot Studio offers, from docs/connector-api-index.json. Override
 *  with CSGE_CONNECTORS=a,b,c to point this at any other family. */
const CONNECTORS = (process.env.CSGE_CONNECTORS ??
  'shared_googledrive,shared_googlesheet,shared_googlecontacts,shared_googlecalendar,' +
  'shared_googlegemini,shared_googletasks,shared_googlepalm,shared_searchapigooglesearch'
).split(',').map((s) => s.trim()).filter(Boolean);

interface Row {
  connectorId: string; operationId: string; method: string; path: string;
  verdict: string; api: string; provenance: string; vendorMethodId: string; detail: string;
}
const rows: Row[] = [];

for (const cid of CONNECTORS) {
  const index = await resolveOpIndex(cid, ctx);
  if (!index) {
    rows.push({ connectorId: cid, operationId: '(all)', method: '', path: '', verdict: 'no-index',
      api: '', provenance: '', vendorMethodId: '',
      detail: 'swagger not retrievable from this environment, cache or fixtures' });
    continue;
  }
  // The index doubles as EVIDENCE: a connector nobody curated is resolved to its vendor API
  // by matching its own captured paths against Google's published ones.
  const surface = await resolveVendorApiSurface(cid, index);
  for (const [opId, op] of Object.entries(index.operations)) {
    const r = bindOperation(index, opId, surface);
    const row: Row = {
      connectorId: cid, operationId: opId, method: op.method,
      path: op.path.replace(/^\/\{connectionId\}/, ''),
      verdict: r.status, api: surface?.api ?? '-', provenance: '', vendorMethodId: '', detail: '',
    };
    if (r.status === 'bindable') {
      row.provenance = r.operation.provenance;
      row.vendorMethodId = r.operation.vendorMethodId ?? '';
      row.detail = `${r.operation.method} ${r.operation.urlTemplate}`;
    } else {
      row.detail = r.reason;
    }
    rows.push(row);
  }
}

const jsonAt = process.argv.indexOf('--json');
if (jsonAt > -1 && process.argv[jsonAt + 1]) {
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify(rows, null, 1));
  console.log(`wrote ${rows.length} rows to ${process.argv[jsonAt + 1]}`);
}

console.log(`\n${CONNECTORS.length} connectors, ${rows.length} operations\n`);
for (const cid of CONNECTORS) {
  const mine = rows.filter((r) => r.connectorId === cid);
  if (!mine.length) continue;
  const ok = mine.filter((r) => r.verdict === 'bindable');
  const confirmed = ok.filter((r) => r.provenance === 'vendor-spec').length;
  console.log(`=== ${cid}  ${ok.length}/${mine.length} bindable (${confirmed} vendor-confirmed)  [api: ${mine[0].api}]`);
  for (const r of mine) {
    console.log(`   ${r.verdict.padEnd(18)}${r.operationId.padEnd(30)}${r.method.padEnd(7)}${r.path}`);
    console.log(`                     -> ${r.vendorMethodId || r.detail}`);
  }
  console.log('');
}

const by = new Map<string, number>();
for (const r of rows) by.set(r.verdict, (by.get(r.verdict) ?? 0) + 1);
console.log('TOTALS across every operation:');
for (const [v, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${v}`);
const b = rows.filter((r) => r.verdict === 'bindable');
const vs = b.filter((r) => r.provenance === 'vendor-spec').length;
console.log(`\nBINDABLE: ${b.length}/${rows.length} (${Math.round((b.length / rows.length) * 100)}%) ` +
  `across ${new Set(b.map((r) => r.connectorId)).size} connector(s); ${vs} confirmed against the vendor's own API`);
process.exit(0);
