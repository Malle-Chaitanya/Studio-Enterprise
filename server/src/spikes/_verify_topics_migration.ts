/**
 * VERIFICATION — run planTopicsMigration over the REAL cached AgentIR corpus and
 * assert it maps every topic into a connected agent without loss. READ-ONLY.
 *
 *   npx tsx src/spikes/_verify_topics_migration.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import { planTopicsMigration } from '../services/topicsMigration.js';
import type { AgentIR } from '../types.js';

let problems = 0;
const flag = (msg: string) => { problems++; console.log(`  ✗ ${msg}`); };

async function main(): Promise<void> {
  await connectMongo();
  const docs = await getDb(config.CSGE_DB)
    .collection<{ ir: AgentIR }>('agentIRCache')
    .find({}, { projection: { ir: 1 } })
    .toArray();
  if (!docs.length) { console.log('No cached AgentIR. Run an extraction first.'); process.exit(0); }

  const line = '─'.repeat(64);
  let totTopics = 0, totCaps = 0, totCA = 0;
  const byClass: Record<string, number> = { system: 0, qa: 0, transactional: 0, orchestration: 0 };
  const byFidelity: Record<string, number> = { full: 0, high: 0, partial: 0 };
  let emptyProcedure = 0, noTriggers = 0, domainFallback = 0, needsReview = 0;

  for (const { ir } of docs) {
    if (!ir?.topics) continue;
    const plan = planTopicsMigration(ir);

    // ── Correctness invariants ────────────────────────────────────────────────
    const grouped = plan.connectedAgents.flatMap((a) => a.capabilities);
    const allCaps = [...plan.systemCapabilities, ...grouped];
    if (allCaps.length !== ir.topics.length)
      flag(`${ir.name}: ${ir.topics.length} topics → ${allCaps.length} capabilities (LOSS)`);

    const capIds = new Set(allCaps.map((c) => c.id));
    for (const t of ir.topics) if (!capIds.has(t.id)) flag(`${ir.name}: topic "${t.name}" produced NO capability`);

    // every non-system topic in exactly one connected agent
    const seen = new Map<string, number>();
    for (const c of grouped) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
    for (const [id, n] of seen) if (n !== 1) flag(`${ir.name}: capability ${id} appears in ${n} connected agents`);
    for (const c of plan.systemCapabilities) if (seen.has(c.id)) flag(`${ir.name}: system capability ${c.id} leaked into a connected agent`);

    // ── Tallies + quality signals ──────────────────────────────────────────────
    totTopics += ir.topics.length; totCaps += allCaps.length; totCA += plan.connectedAgents.length;
    for (const c of allCaps) {
      byClass[c.classification]++; byFidelity[c.fidelity]++;
      if (c.needsHumanReview) needsReview++;
      if (c.classification !== 'system' && !c.procedure.trim()) emptyProcedure++;
      if (c.classification !== 'system' && c.triggers.length === 0) noTriggers++;
      if (c.domain === ir.name) domainFallback++;
    }
  }

  console.log(`\n${line}\n REAL-CORPUS MAPPING (planTopicsMigration)\n${line}`);
  console.log(` Agents: ${docs.length}  ·  Topics: ${totTopics}  ·  Capabilities: ${totCaps}  ·  Connected agents: ${totCA}`);
  console.log(`\n By class:    ` + Object.entries(byClass).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(` By fidelity: ` + Object.entries(byFidelity).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(` Needs review: ${needsReview}  ·  empty procedure: ${emptyProcedure}  ·  no triggers: ${noTriggers}  ·  domain=agent-name fallback: ${domainFallback}`);

  // ── Eyeball: show the connected-agent grouping for the multi-topic agents ────
  console.log(`\n${line}\n CONNECTED-AGENT GROUPINGS (agents with >1 business capability)\n${line}`);
  for (const { ir } of docs) {
    if (!ir?.topics) continue;
    const plan = planTopicsMigration(ir);
    const business = plan.connectedAgents.reduce((n, a) => n + a.capabilities.length, 0);
    if (business < 2) continue;
    console.log(`\n ▸ ${ir.name}  (${business} caps → ${plan.connectedAgents.length} connected agents)`);
    for (const a of plan.connectedAgents) {
      console.log(`    ┌ ${a.domain}  [${a.capabilities.length} cap, ${a.tools.length} tool]`);
      for (const c of a.capabilities)
        console.log(`    │   ${c.classification.padEnd(13)} ${c.fidelity.padEnd(7)} ${c.needsHumanReview ? '⚠ ' : '  '}${c.name}`);
    }
  }

  console.log(`\n${line}`);
  console.log(problems === 0 ? ' ✓ All correctness invariants held (no loss, no leaks, no duplicates).' : ` ✗ ${problems} problem(s) found.`);
  console.log(line + '\n');
  process.exit(problems ? 1 : 0);
}
main().catch((e) => { console.error('VERIFY FAILED:', (e as Error).message); process.exit(1); });
