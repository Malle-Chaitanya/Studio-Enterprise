/**
 * Everything the pipeline can see about specific agents, by name fragment.
 *
 * Answers "can we migrate THIS agent" without running a migration: what extraction gets,
 * which tools bind to a real vendor call, and every fidelity note the binder would emit.
 * Searches ALL environments and says which it could not read, so a name that is missing
 * because of a 403 is never reported as a name that does not exist.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_agent_detail.ts "Migration Advisory" "Knowledge Assistant"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import { readinessFor } from '../connectors/readiness.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

const NEEDLES = process.argv.slice(2);
if (!NEEDLES.length) {
  console.error('usage: _diag_agent_detail.ts "<name fragment>" ["<name fragment>" …]');
  process.exit(1);
}

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as
  { tenantId?: string; environments?: Array<{ url: string; name: string; id: string }> } | null;
const tenantId = cache!.tenantId!;
const envs = cache!.environments ?? [];

const unreadable: string[] = [];
let found = 0;

for (const env of envs) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch (err) {
    unreadable.push(`${env.name} (${env.url}) — ${(err as Error).message.slice(0, 90)}`);
    continue;
  }

  const hits = bots.filter((b) =>
    NEEDLES.some((n) => b.name.toLowerCase().includes(n.toLowerCase())),
  );
  for (const bot of hits) {
    found++;
    console.log(`\n${'='.repeat(78)}`);
    console.log(`  ${bot.name}`);
    console.log(`  env: ${env.name}`);
    console.log('='.repeat(78));

    let ir;
    try {
      ir = await extractAgent(env.url, token, bot);
    } catch (err) {
      console.log(`  EXTRACTION FAILED: ${(err as Error).message.slice(0, 200)}`);
      continue;
    }

    console.log(`  instructions   ${(ir.instructions ?? '').length} chars`);
    console.log(`  description    ${(ir.description ?? '').length} chars`);
    console.log(`  topics         ${(ir.topics ?? []).length}`);
    console.log(`  starterPrompts ${(ir.starterPrompts ?? []).length}`);
    console.log(`  webBrowsing    ${ir.capabilities?.webBrowsing ? 'ON' : 'off'}`);
    console.log(`  managed        ${ir.isManaged ? 'YES (Microsoft-authored)' : 'no'}`);
    console.log(`  thinContent    ${ir.thinContent ? 'YES — nothing authored to migrate' : 'no'}`);

    const ks = ir.knowledgeSources ?? [];
    console.log(`\n  knowledge sources: ${ks.length}`);
    for (const k of ks) {
      const strat = k.classification?.strategy ?? '(unclassified)';
      const extra = [
        k.confluenceSpaceNames?.length ? `spaces=${k.confluenceSpaceNames.join('|')}` : '',
        k.sharePointSiteUrl ? `sp=${k.sharePointSiteUrl}` : '',
        k.dataverseEntity ? `entity=${k.dataverseEntity}` : '',
      ].filter(Boolean).join(' ');
      console.log(`    - ${(k.name ?? '(unnamed)').slice(0, 40).padEnd(40)} kind=${k.kind} strategy=${strat} ${extra}`);
    }

    const tools = ir.agentTools ?? [];
    console.log(`\n  tools: ${tools.length}`);
    if (tools.length) {
      const build = await buildBoundToolSpecs(
        ir,
        { tenantId, environmentId: env.id, scope: `ms-${tenantId}` },
        { dataverseOrgUrl: env.url },
      ).catch((e) => {
        console.log(`    BINDER THREW: ${(e as Error).message.slice(0, 150)}`);
        return null;
      });
      const boundIds = new Set([...(build?.byConnector.values() ?? [])].flat().map((s) => s.operationId));
      for (const t of tools) {
        const state =
          t.kind !== 'connector'
            ? `kind=${t.kind} — not a connector call`
            : t.operationId && boundIds.has(t.operationId)
              ? 'BINDS'
              : 'no bound call';
        console.log(
          `    - ${(t.name ?? '').slice(0, 44).padEnd(44)} ${(t.connectorId ?? '(no connector id)').padEnd(36)} ${t.operationId ?? ''} → ${state}`,
        );
      }
      const notes = build?.notes ?? [];
      console.log(`\n  (1) fidelity notes from the BINDER: ${notes.length}`);
      for (const n of notes) {
        console.log(`    [${n.status}] ${n.component}`);
        console.log(`        ${n.detail.slice(0, 200)}`);
      }

      // The binder is only ONE of three reporters. Reading it alone made 14 unbound tools
      // look silently lost when the orchestrator reports them by two other paths — an
      // instrument that sees a third of the picture is how a wrong "silently absent"
      // claim gets made. Reproduce the orchestrator's other two passes here.
      const opsByConnector = new Map<string, string[]>();
      for (const t of tools) {
        if (t.kind !== 'connector' || !t.connectorId || !t.operationId) continue;
        opsByConnector.set(t.connectorId, [...(opsByConnector.get(t.connectorId) ?? []), t.operationId]);
      }

      // A CUSTOM connector can never have a registry entry but may still bind from its
      // published definition, so "produced a real call" counts as support — matching
      // orchestrator.ts. Without this the spike reports a connector as unsupported on the
      // same run it prints four BINDS for it.
      console.log(`\n  (2) orchestrator — connectors with no support (no registry entry AND no bound call):`);
      let noEntry = 0;
      const boundConnectors = new Set(build?.byConnector.keys() ?? []);
      for (const [cid, ops] of opsByConnector) {
        if (REGISTRY_BY_ID.has(cid) || boundConnectors.has(cid)) continue;
        noEntry++;
        console.log(`    [lost] connector:${cid} — no connector support. Operations wanted: ${ops.join(', ')}`);
      }
      if (!noEntry) console.log('    (none)');

      // What the tools will actually call — the point of the whole exercise.
      for (const [cid, specs] of build?.byConnector ?? []) {
        console.log(`\n  bound calls for ${cid.slice(0, 50)}:`);
        for (const s of specs) {
          console.log(`    ${s.method.padEnd(5)} ${s.urlTemplate}`);
          console.log(`       description: ${(s.description || '(none)').slice(0, 90)}`);
        }
      }

      console.log(`\n  (3) orchestrator — per-OPERATION readiness (registered connectors):`);
      let blockedCount = 0;
      for (const [cid, ops] of opsByConnector) {
        const readiness = readinessFor(cid, ops);
        if (!readiness) continue;
        for (const b of readiness.blocked) {
          blockedCount++;
          console.log(`    [lost] ${cid}.${b.operationId} on ${readiness.displayName}`);
          console.log(`        ${b.reason.slice(0, 190)}`);
        }
      }
      if (!blockedCount) console.log('    (none blocked)');

      const reported = notes.length + noEntry + blockedCount;
      const unbound = tools.filter(
        (t) => t.kind === 'connector' && t.operationId && !boundIds.has(t.operationId),
      ).length;
      console.log(
        `\n  >> ${unbound} connector tool(s) produce no call; ${reported} note(s) across all three reporters.`,
      );
    }

    // ir.unmapped is a string[]; Object.keys() on it yields indices, which is how
    // "unmapped: 0, 1" got printed instead of the two field names it actually holds.
    const un = Array.isArray(ir.unmapped) ? ir.unmapped : Object.values(ir.unmapped ?? {});
    if (un.length) {
      console.log(`\n  unmapped (read but NOT reproduced): ${un.length}`);
      for (const u of un) console.log(`    - ${String(u).slice(0, 160)}`);
    }
  }
}

console.log(`\n${'─'.repeat(78)}`);
console.log(`matched ${found} agent(s) for: ${NEEDLES.map((n) => `"${n}"`).join(', ')}`);
if (unreadable.length) {
  console.log(`\nCOULD NOT SEARCH ${unreadable.length} environment(s) — a name missing above may exist here:`);
  for (const u of unreadable) console.log(`  ${u}`);
}
process.exit(0);
