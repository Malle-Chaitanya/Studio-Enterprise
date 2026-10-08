/**
 * CAN THE GENERIC PATH REPLACE THE HAND-WRITTEN MODULES? Evidence, per connector.
 *
 * `adk_deploy.py` forks before `generic_rest.py` for 11 connector families and hands each to a
 * hand-written Python module instead. Those modules predate the operation map. This probe asks
 * the only question that decides whether they can be deleted: for the operations a customer's
 * agents ACTUALLY selected, does the map bind what the module implements?
 *
 * THREE FACTS IT MEASURES, none of them recalled:
 *   1. the module's surface   — its tool list and the distinct vendor endpoints it calls,
 *                               parsed from the module itself
 *   2. the generic surface    — `bindWithMap()` per operation, the PRODUCT's own decision path
 *   3. the selection fidelity — whether the module reads the agent's chosen operations at all
 *
 * (3) is the one that cannot be fixed by writing more Python. A module takes `conn` and returns
 * a FIXED list; only `generic_rest` reads `conn["operations"]`. So a hand-written connector
 * grants every tool it knows regardless of what the source agent used — widening a 'specific'
 * selection to all, and narrowing 'all' to whatever was hand-written. That is a fidelity defect
 * in both directions, and it is structural.
 *
 *   CSGE_TENANT_ID=<guid> CSGE_ENVIRONMENT_ID=<guid> CSGE_ENV_URL=https://orgNNNN.crm.dynamics.com \
 *     npx tsx src/spikes/_probe_shadow_diff.ts
 *
 * Reports only. Binds nothing, deploys nothing, writes nothing.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { resolveVendorApiSurface } from '../connectors/vendorSpec.js';
import { bindWithMap } from '../connectors/bindWithMap.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`${name} is not set; this probe reports on a CUSTOMER environment and has no default.`); process.exit(2); }
  return v;
}
const ctx: CaptureContext = {
  tenantId: requireEnv('CSGE_TENANT_ID'),
  environmentId: requireEnv('CSGE_ENVIRONMENT_ID'),
  scope: `ms-${requireEnv('CSGE_TENANT_ID')}`,
};
requireEnv('CSGE_ENV_URL');

/** connectorId -> the module `adk_deploy.py` hands it to, mirroring that file's fork order. */
const INTERCEPTED: Record<string, string> = {
  shared_googledrive: 'google_drive',
  shared_googlecalendar: 'calendar',
  shared_googlecontacts: 'contacts',
  shared_sharepointonline: 'sharepoint',
  shared_wordonlinebusiness: 'word_online',
};
const CONNECTORS = (process.env.CSGE_CONNECTORS ??
  'shared_googledrive,shared_googlesheet,shared_googlecontacts,shared_googlecalendar,shared_googletasks'
).split(',').map((s) => s.trim()).filter(Boolean);

/** The module's own surface, read from the module. Regex over Python is crude, but these are
 *  literal URLs and a literal return list — and reading them beats restating them here. */
function moduleSurface(mod: string): { tools: string[]; endpoints: string[]; readsOperations: boolean } | null {
  const path = `scripts/connector_tools/${mod}.py`;
  if (!existsSync(path)) return null;
  const src = readFileSync(path, 'utf8');
  const ret = src.match(/def build_tools[\s\S]*?\n    return \[([\s\S]*?)\]/);
  const tools = ret ? [...ret[1].matchAll(/\b([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]) : [];
  const endpoints = [...new Set(
    [...src.matchAll(/https:\/\/[\w.]+\/[\w/]*v\d[\w/]*/g)].map((m) => m[0].replace(/\/$/, '')),
  )].sort();
  return { tools, endpoints, readsOperations: /conn\.get\("operations"\)|conn\["operations"\]/.test(src) };
}

let totalOps = 0, totalBindable = 0;
for (const cid of CONNECTORS) {
  const index = await resolveOpIndex(cid, ctx);
  if (!index) { console.log(`=== ${cid}\n    no swagger reachable from this environment\n`); continue; }
  const surface = await resolveVendorApiSurface(cid, index);

  const bindable: string[] = [], blocked: Array<[string, string]> = [];
  const vendorMethods = new Set<string>();
  for (const opId of Object.keys(index.operations)) {
    const r = await bindWithMap(index, opId, surface);
    if (r.status === 'bindable') {
      bindable.push(opId);
      if (r.operation.vendorMethodId) vendorMethods.add(r.operation.vendorMethodId);
    } else blocked.push([opId, r.reason]);
  }
  totalOps += bindable.length + blocked.length;
  totalBindable += bindable.length;

  const mod = INTERCEPTED[cid];
  const hand = mod ? moduleSurface(mod) : null;
  const n = bindable.length + blocked.length;
  console.log(`=== ${cid}   ${bindable.length}/${n} operations bindable generically`);
  console.log(`    dispatch today : ${mod ? `HAND-WRITTEN connector_tools/${mod}.py` : 'generic_rest.py (map IS used)'}`);
  if (hand) {
    console.log(`    module provides: ${hand.tools.length} fixed tools`);
    console.log(`    module calls   : ${hand.endpoints.join('  ') || '(none found)'}`);
    console.log(`    reads agent's selected operations: ${hand.readsOperations ? 'YES' : 'NO  <-- grants a fixed list regardless of the source agent'}`);
    console.log(`    generic reaches: ${[...vendorMethods].slice(0, 6).join(' ')}${vendorMethods.size > 6 ? ` +${vendorMethods.size - 6}` : ''}`);
    const verdict = blocked.length === 0 ? 'REPLACEABLE — map binds every operation'
      : `REPLACEABLE EXCEPT ${blocked.length}: ${blocked.map(([o]) => o).join(', ')}`;
    console.log(`    VERDICT        : ${verdict}`);
  }
  if (bindable.length) console.log(`    binds generically: ${bindable.join(', ')}`);
  if (blocked.length) {
    console.log('    not bindable generically:');
    for (const [o, why] of blocked) console.log(`      ${o.padEnd(26)} ${why.slice(0, 96)}`);
  }
  console.log('');
}
console.log(`TOTAL: ${totalBindable}/${totalOps} operations bindable without any hand-written module`);
process.exit(0);
