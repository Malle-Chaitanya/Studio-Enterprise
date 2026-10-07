/**
 * Pull the REAL Copilot agents that use a Google connector, and report — per tool — whether
 * this codebase can reproduce them. Reports only; creates nothing, deploys nothing.
 *
 * WHY. Every Google readiness number so far came from the connector CATALOGUE: 8 connectors,
 * 103 paths, a verdict per connector from 3 sample paths. That answers "could a connector be
 * bound", not "can the agents a customer actually built be migrated". Those differ in the
 * direction that matters — an agent uses a handful of specific operations, and a connector
 * being 93% bindable says nothing about whether THOSE ones are.
 *
 * So: the same calls the product makes at build time, against the live tenant, on real
 * agents. resolveOpIndex -> bindOperation per tool, then the counts.
 *
 * Needs MS_CLIENT_ID/MS_CLIENT_SECRET (app-only, already minted for Dataverse extraction).
 * Mongo is optional: without it resolveOpIndex just skips its cache and the registry and
 * captures live, which is the freshest source anyway.
 *
 *   cd server && npx tsx src/spikes/_probe_google_agent_readiness.ts
 *   cd server && npx tsx src/spikes/_probe_google_agent_readiness.ts --all   (every connector)
 *
 * Throwaway diagnostic. Not app code.
 */
import 'dotenv/config';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { bindOperation } from '../connectors/operationBinding.js';
import { resolveVendorApiSurface } from '../connectors/vendorSpec.js';
import type { AgentIR } from '../types.js';

/**
 * Tenant, environment and scope come from the ENVIRONMENT, never from a literal.
 *
 * An earlier version of this probe hardcoded one tenant's GUIDs. That is fine for a one-off
 * measurement and useless as an answer: a customer installs a different set of connectors,
 * sometimes at different VERSIONS, which is exactly why captureOpIndex reads the swagger
 * from the customer's own environment rather than shipping one capture of ours. A result
 * from a hardcoded tenant is a sample, and reading it as a spec is how "9% bindable" becomes
 * a number nobody can act on.
 *
 *   CSGE_TENANT_ID=<entra tenant guid>  *   CSGE_ENV_URL=https://orgNNNN.crm.dynamics.com  *   CSGE_ENVIRONMENT_ID=<power platform environment guid>  *     npx tsx src/spikes/<this file>
 */
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
const ENV_URL = requireEnv('CSGE_ENV_URL');
const ENVIRONMENT_ID = requireEnv('CSGE_ENVIRONMENT_ID');
const ctx: CaptureContext = { tenantId: TENANT_ID, environmentId: ENVIRONMENT_ID, scope: `ms-${TENANT_ID}` };

const ALL = process.argv.includes('--all');
const WANTED = /google|gmail/i;

function note(s: string) {
  // ASCII only: the Windows console this runs on mangles anything else, and a mangled
  // diagnostic is one people stop reading.
  console.log(s);
}

const token = await clientCredsToken(TENANT_ID, ENV_URL);
const bots = await listBots(ENV_URL, token);
note(`${bots.length} agents in ${ENV_URL}\n`);

interface Row {
  agent: string;
  connectorId: string;
  operationId: string;
  toolName: string;
  status: string;
  reason: string;
  method?: string;
  url?: string;
  modelArgs?: number;
  described?: number;
  provenance?: string;
}

const rows: Row[] = [];
const agentsWithGoogle: string[] = [];
let extracted = 0;

for (const bot of bots) {
  let ir: AgentIR;
  try {
    ir = await extractAgent(ENV_URL, token, bot as never);
  } catch (e) {
    note(`  ! ${(bot as { name?: string }).name ?? '?'}: extract failed - ${(e as Error).message}`);
    continue;
  }
  extracted++;
  const tools = (ir.agentTools ?? []).filter(
    (t) => t.connectorId && (ALL || WANTED.test(t.connectorId)),
  );
  if (!tools.length) continue;
  if (WANTED.test(tools.map((t) => t.connectorId).join(','))) agentsWithGoogle.push(ir.name || bot.name || '?');

  for (const tool of tools) {
    const row: Row = {
      agent: ir.name || '?',
      connectorId: tool.connectorId!,
      operationId: tool.operationId || '(none)',
      toolName: tool.displayName || tool.name,
      status: '',
      reason: '',
    };
    if (!tool.operationId) {
      row.status = 'no-operation-id';
      row.reason = `tool kind '${tool.kind}' carries no operationId, so there is nothing to bind`;
      rows.push(row);
      continue;
    }
    const index = await resolveOpIndex(tool.connectorId!, ctx);
    if (!index) {
      row.status = 'no-index';
      row.reason = 'connector swagger not retrievable from this environment, cache or fixtures';
      rows.push(row);
      continue;
    }
    // The PRODUCT's own path, not a probe-local reimplementation of it: same resolver,
    // same binding call, same vendor-spec confirmation the migration will do.
    const surface = await resolveVendorApiSurface(tool.connectorId!);
    const bound = bindOperation(index, tool.operationId, surface);
    row.status = bound.status;
    if (bound.status === 'bindable') {
      row.method = bound.operation.method;
      row.url = bound.operation.urlTemplate;
      row.modelArgs = bound.operation.parameters.length;
      // The R1 question, asked of real data: of the arguments this tool will hand the
      // model, how many carry a description it can act on? Zero means the tool deploys
      // and the model fills `$filter` by guessing.
      row.described = bound.operation.parameters.filter((p) => p.description).length;
      row.provenance = bound.operation.provenance;
      row.reason = bound.operation.provenance === 'vendor-spec'
        ? `confirmed as ${bound.operation.vendorMethodId}`
        : 'path shape only - the vendor publishes no API we can check against';
    } else {
      row.reason = (bound as { reason: string }).reason;
    }
    rows.push(row);
  }
}

note(`extracted ${extracted}/${bots.length} agents`);
note(`agents using a Google connector: ${agentsWithGoogle.length}` +
  (agentsWithGoogle.length ? ` - ${[...new Set(agentsWithGoogle)].join(', ')}` : ''));
note(`connector tools examined: ${rows.length}\n`);

if (!rows.length) {
  note('No matching connector tools found. Re-run with --all to see every connector.');
  process.exit(0);
}

note('agent'.padEnd(26) + 'connector'.padEnd(26) + 'operation'.padEnd(26) + 'status');
note('-'.repeat(100));
for (const r of rows) {
  note(r.agent.slice(0, 25).padEnd(26) + r.connectorId.slice(0, 25).padEnd(26) +
    r.operationId.slice(0, 25).padEnd(26) + r.status);
}

const byStatus = new Map<string, number>();
for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
note('\ncounts by status:');
for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) note(`  ${String(n).padStart(3)}  ${s}`);

const ok = rows.filter((r) => r.status === 'bindable');
note(`\nBINDABLE (${ok.length}/${rows.length}) - the real call each would make:`);
for (const r of ok) {
  note(`  ${r.method} ${r.url}`);
  note(`      ${r.agent} / ${r.toolName}  [${r.described}/${r.modelArgs} model args carry a description]`);
}

const blocked = rows.filter((r) => r.status !== 'bindable');
if (blocked.length) {
  note(`\nNOT BINDABLE (${blocked.length}/${rows.length}) - where we are lacking:`);
  const seen = new Set<string>();
  for (const r of blocked) {
    const key = `${r.connectorId}|${r.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    note(`  ${r.connectorId} [${r.status}]`);
    note(`      ${r.reason}`);
  }
}

process.exit(0);
