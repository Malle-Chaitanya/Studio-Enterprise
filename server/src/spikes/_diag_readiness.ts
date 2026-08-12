/**
 * Which agents migrate with NOTHING lost?
 *
 * Two different questions get confused here, so this prints both per agent:
 *
 *   RUN-CLEAN   — the migration completes without an error. Almost everything is
 *                 run-clean, because losses are reported as fidelity notes, not thrown.
 *                 This is the weaker, and more misleading, sense of "no errors".
 *   FAITHFUL    — every component of the source agent has a migrated equivalent:
 *                 instructions, every topic, every knowledge source, and every tool
 *                 producing a real vendor call. Nothing `lost`, nothing `manual`.
 *
 * An agent can be run-clean and still arrive missing half its capability. That gap is the
 * entire reason this file exists.
 *
 * FAITHFUL is a claim about MAPPING, not about runtime: it says every part has a target,
 * not that a credential is valid or that a call returns 200. Runtime is proven only by
 * running one.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_readiness.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { assessAgent } from '../services/assess.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

interface Row {
  env: string;
  name: string;
  verdict: 'FAITHFUL' | 'PARTIAL' | 'THIN';
  blockers: string[];
  needs: string[];
  /** How much there was to be faithful TO. "Nothing was lost" is a weak claim over an
   *  agent with 40 characters of instruction and no topics. */
  size: string;
}
const rows: Row[] = [];
const unreadable: string[] = [];

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch (err) {
    unreadable.push(`${env.name} — ${(err as Error).message.slice(0, 80)}`);
    continue;
  }

  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;

    const a = assessAgent(ir);
    const blockers: string[] = [];
    const needs: string[] = [];

    // 1. Tools — the part most likely to be silently absent.
    const tools = ir.agentTools ?? [];
    if (tools.length) {
      const build = await buildBoundToolSpecs(ir, { tenantId, environmentId: env.id }, {});
      const built = new Set(
        [...build.byConnector.values()].flat().map((s) => `${s.connectorId}.${s.operationId}`),
      );
      const dead = tools.filter((t) => {
        if (!t.connectorId) return true;
        if (t.kind === 'mcp-server') return !(t.mcp?.tools ?? []).some((op) => built.has(`${t.connectorId}.${op}`));
        return !t.operationId || !built.has(`${t.connectorId}.${t.operationId}`);
      });
      if (dead.length) blockers.push(`${dead.length}/${tools.length} tool(s) produce no call: ${[...new Set(dead.map((d) => d.connectorId ?? d.kind))].join(', ')}`);
      for (const id of new Set(tools.map((t) => t.connectorId).filter(Boolean))) needs.push(`credential: ${id}`);
    }

    // 2. Knowledge — 'manual' means a human recreates it; 'reconnect' means setup first.
    for (const k of a.knowledge?.actions ?? []) {
      if (k.disposition === 'manual') blockers.push(`knowledge needs manual work: ${k.title}`);
      if (k.disposition === 'reconnect') needs.push(`connector setup: ${k.title}`);
    }

    // 3. Components the assessment itself calls unmigratable.
    for (const c of a.components) {
      if (c.compatibility === 'none') blockers.push(`no equivalent: ${c.component}`);
      else if (c.compatibility === 'manual' && !c.kind.startsWith('tool') && c.kind !== 'knowledge') {
        blockers.push(`manual: ${c.component}`);
      }
    }

    // 4. An agent with no instructions AND no readable topics has nothing to be faithful
    //    TO — reporting it as a clean migration is the false all-clear that started this.
    const thin = !ir.instructions && ir.topics.length === 0 && tools.length === 0;

    rows.push({
      env: env.name,
      name: ir.name,
      verdict: thin ? 'THIN' : blockers.length ? 'PARTIAL' : 'FAITHFUL',
      blockers,
      needs: [...new Set(needs)],
      size: `${ir.instructions.length}ch instr · ${ir.topics.length} topic(s) · ${tools.length} tool(s) · ${ir.knowledgeSources.length} knowledge`,
    });
  }
}

const order = { FAITHFUL: 0, PARTIAL: 1, THIN: 2 } as const;
rows.sort((x, y) => order[x.verdict] - order[y.verdict] || x.name.localeCompare(y.name));

for (const v of ['FAITHFUL', 'PARTIAL', 'THIN'] as const) {
  const group = rows.filter((r) => r.verdict === v);
  console.log(`\n${'='.repeat(78)}\n  ${v} — ${group.length} agent(s)\n${'='.repeat(78)}`);
  for (const r of group) {
    console.log(`\n  ${r.name}   [${r.env}]`);
    console.log(`      ${r.size}`);
    for (const b of r.blockers.slice(0, 6)) console.log(`      x ${b}`);
    if (r.blockers.length > 6) console.log(`      x … ${r.blockers.length - 6} more`);
    for (const n of r.needs) console.log(`      · ${n}`);
  }
}

console.log(`\n${'─'.repeat(78)}`);
console.log(`${rows.length} agent(s) graded · ${rows.filter((r) => r.verdict === 'FAITHFUL').length} faithful · ` +
  `${rows.filter((r) => r.verdict === 'PARTIAL').length} partial · ${rows.filter((r) => r.verdict === 'THIN').length} thin`);
console.log('FAITHFUL = every component has a migrated equivalent. It does NOT mean a live run has been proven.');
if (unreadable.length) {
  console.log(`\nNOT GRADED — ${unreadable.length} environment(s) could not be listed:`);
  for (const u of unreadable) console.log(`  ${u}`);
}
process.exit(0);
