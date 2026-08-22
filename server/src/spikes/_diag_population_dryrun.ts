/**
 * Would a migration of EVERY staged agent produce errors — and where?
 *
 * A real end-to-end run needs a browser sign-in (migrationSessions has a Mongo TTL and there
 * is none right now), and it would migrate one selection at a time anyway. This exercises the
 * parts that do NOT need a session, across all 151 staged agents at once:
 *
 *   - operation binding for every tool each agent declares (offline: resolveOpIndex falls back
 *     to the captured fixture when no capture context is supplied)
 *   - the live connector spec build, i.e. whether a credential exists for what the agent uses
 *   - the verdict lookup the report performs, in BOTH tables
 *
 * What it deliberately does NOT do: deploy, call Gemini, or touch the customer's data. It
 * answers "which agents would report a problem, and is that problem real?" — so a live run is
 * not the first place a whole class of failure is discovered.
 *
 *   cd server && npx tsx src/spikes/_diag_population_dryrun.ts [--verbose]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import { buildLiveConnectorSpecsDetailed, agentConnectorIds } from '../services/connectorToolBuilder.js';
import { findCoverage } from '../connectors/coverage.js';
import { findEquivalence, surfaceForConnector } from '../connectors/equivalence.js';
import { hasDedicatedToolModule } from '../connectors/toolModule.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import type { AgentIR } from '../types.js';

const VERBOSE = process.argv.includes('--verbose');

await connectMongo();
const db = getDb();

const creds = (await db.collection('connectorCredentials').find({}).toArray()) as Array<{
  connectorId?: string; secretIds?: Record<string, string>; ownerScope?: string;
}>;
const storedSecretIds = Object.fromEntries(
  creds.filter((c) => c.connectorId).map((c) => [c.connectorId!, c.secretIds ?? {}]),
);
const secretIdOpts = { ownerScope: creds[0]?.ownerScope ?? 'default', storedSecretIds };
const configured = new Set(creds.map((c) => c.connectorId).filter(Boolean) as string[]);

const staged = (await db.collection('stagedAgents').find({}).toArray()) as Array<Record<string, unknown>>;
console.log(`${staged.length} staged agent(s), ${configured.size} configured connector(s)\n`);

let ok = 0;
const threw: Array<{ name: string; err: string }> = [];
/** connectorId -> agents that use it but have NO credential saved */
const noCredential = new Map<string, string[]>();
/** connectorId:operationId -> agents affected, for operations nothing can answer */
const unjudged = new Map<string, string[]>();
/** Operations whose binding was REFUSED, grouped by reason. */
const refused = new Map<string, string[]>();

for (const row of staged) {
  const name = String(row.displayName ?? row.name ?? '?');
  const ir = (row.mapped as { ir?: AgentIR } | undefined)?.ir;
  if (!ir) continue;

  try {
    // No capture context on purpose: this must run without a signed-in session, and
    // resolveOpIndex then falls back to the captured fixture for the connector.
    const build = await buildBoundToolSpecs(ir, undefined, {});
    const ids = [...agentConnectorIds(ir)];
    const { unsupported } = buildLiveConnectorSpecsDetailed(ids, secretIdOpts);

    for (const id of ids) {
      if (!configured.has(id) && !unsupported.includes(id)) {
        // Registered, understood, and no credential saved — the agent deploys without it.
        noCredential.set(id, [...(noCredential.get(id) ?? []), name]);
      }
    }

    // Every refusal note the binder produced. These become `lost` lines in the report, so
    // they are the closest thing to "this agent will not fully work" available offline.
    for (const note of build.notes) {
      if (note.status !== 'lost') continue;
      const key = `${note.component} :: ${note.detail.slice(0, 90)}`;
      refused.set(key, [...(refused.get(key) ?? []), name]);
    }

    // The report's own lookup, in both tables — a miss here is an operation the customer
    // gets a needs-review line for instead of an answer.
    for (const tool of ir.agentTools ?? []) {
      if (!tool.connectorId || !tool.operationId) continue;
      if (!hasDedicatedToolModule(tool.connectorId)) continue; // generic REST: the bound tool IS the answer
      const surface = surfaceForConnector(tool.connectorId);
      const judged =
        findCoverage(tool.connectorId, tool.operationId) ??
        (surface ? findEquivalence(surface, tool.operationId) : undefined);
      if (!judged) {
        const key = `${tool.connectorId}:${tool.operationId}`;
        unjudged.set(key, [...(unjudged.get(key) ?? []), name]);
      }
    }
    ok++;
    if (VERBOSE) {
      const bound = [...build.byConnector.values()].reduce((n, v) => n + v.length, 0);
      console.log(`  ok  ${name.slice(0, 44).padEnd(46)} tools=${ir.agentTools?.length ?? 0} bound=${bound}`);
    }
  } catch (e) {
    // A THROW is the thing that matters most: the orchestrator catches per-agent, so this
    // would surface as a failed agent in a live run rather than as a crash.
    threw.push({ name, err: (e as Error).message });
  }
}

console.log(`\n================ POPULATION DRY RUN ================`);
console.log(`${ok}/${staged.length} agent(s) built their tool specs with no exception`);

if (threw.length) {
  console.log(`\n${threw.length} agent(s) THREW — these would fail in a live run:`);
  for (const t of threw) console.log(`  ${t.name.slice(0, 44).padEnd(46)} ${t.err.slice(0, 90)}`);
} else {
  console.log('No agent threw while building its tool specs.');
}

if (unjudged.size) {
  console.log(`\n${unjudged.size} operation(s) on dedicated-module connectors have NO verdict:`);
  for (const [k, names] of [...unjudged].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(names.length).padStart(3)} agent(s)  ${k}`);
  }
} else {
  console.log('Every operation on a dedicated-module connector has a verdict in one of the two tables.');
}

if (noCredential.size) {
  console.log(`\nConnectors used by agents with NO saved credential (they deploy without the tool):`);
  for (const [id, names] of [...noCredential].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(names.length).padStart(3)} agent(s)  ${id.padEnd(34)} ${REGISTRY_BY_ID.get(id)?.name ?? '(not in registry)'}`);
  }
}

if (refused.size) {
  console.log(`\nRefused bindings (each becomes a \`lost\` line in the report):`);
  for (const [k, names] of [...refused].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
    console.log(`  ${String(names.length).padStart(3)} agent(s)  ${k}`);
  }
  if (refused.size > 25) console.log(`  ... and ${refused.size - 25} more distinct refusal(s)`);
}
process.exit(0);
