/**
 * Does a MAPPED operation actually work against the vendor? The gate every number in this
 * area has been missing.
 *
 * Everything so far is STRUCTURALLY verified: the call is well-formed against both sides'
 * published schemas. That cannot catch the failure that matters -- a valid call that returns
 * the WRONG ROWS. `supportsAllDrives` is the standing example: omit it and Drive silently
 * drops every shared-drive file the connector used to show, with a 200 and no error.
 *
 * So this drives BOTH real code paths rather than re-deriving either:
 *   - `buildBoundToolSpecs()` produces the specs, exactly as the orchestrator does
 *   - the emitted payload is what `generic_rest.py` consumes, so the Python runner executes
 *     the product's own tool code, not a TypeScript imitation of it
 *
 * READ-ONLY. It emits only operations whose bound method is GET; nothing here can create,
 * modify or delete a customer's data.
 *
 *   CSGE_SOURCE_ID=<agent guid> CSGE_TENANT_ID=... CSGE_ENVIRONMENT_ID=... \
 *     npx tsx src/spikes/_probe_behavioral_gate.ts
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import type { CaptureContext } from '../connectors/captureOpIndex.js';

const SOURCE_ID = process.env.CSGE_SOURCE_ID;
const OUT = process.env.CSGE_OUT ?? 'gate_payload.json';
const ctx: CaptureContext | undefined = process.env.CSGE_TENANT_ID && process.env.CSGE_ENVIRONMENT_ID
  ? { tenantId: process.env.CSGE_TENANT_ID, environmentId: process.env.CSGE_ENVIRONMENT_ID, scope: `ms-${process.env.CSGE_TENANT_ID}` }
  : undefined;

await connectMongo();
const row: any = SOURCE_ID
  ? await getDb().collection('agentIRCache').findOne({ sourceId: SOURCE_ID })
  : (await getDb().collection('agentIRCache').find({}).toArray())
      .find((r: any) => (r.ir?.agentTools ?? []).some((t: any) => /google/i.test(t.connectorId ?? '')));
if (!row) throw new Error('no cached agent with Google connector tools — run extraction first');

const build = await buildBoundToolSpecs(row.ir, ctx);
const conns: any[] = [];
for (const [connectorId, specs] of build.byConnector) {
  if (!/google/i.test(connectorId)) continue;
  // GET only. A behavioral gate that could write would be a gate nobody dares run.
  const reads = specs.filter((s) => s.method.toUpperCase() === 'GET');
  if (!reads.length) continue;
  conns.push({
    kind: connectorId.replace(/^shared_/, ''),
    name: connectorId,
    authKind: 'bearer',
    boundOperations: reads.map((s) => ({ ...s })),
  });
}
writeFileSync(OUT, JSON.stringify({ agent: row.ir?.name, conns }, null, 1));
console.log(`agent: ${row.ir?.name}`);
for (const c of conns) {
  console.log(`  ${c.name}: ${c.boundOperations.length} read-only bound operation(s)`);
  for (const o of c.boundOperations) {
    const req = o.modelArgs.filter((a: any) => a.required).map((a: any) => a.name);
    console.log(`     ${o.operationId.padEnd(26)} requires: ${req.join(', ') || '(none)'}`);
  }
}
console.log(`\nwrote ${OUT}`);
process.exit(0);
