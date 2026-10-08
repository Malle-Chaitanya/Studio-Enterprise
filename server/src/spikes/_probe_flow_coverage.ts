/**
 * EVERY cached agent's flows, through the real translator. Answers "are we migrating
 * workflows, and how much of each one survives" with counts rather than opinion.
 *
 * Reads the AgentIR cache (extraction must have run at least once) and re-runs
 * `translateFlow` -- the same pure function the migration uses -- so the numbers here are
 * what a real run would produce. Reports only; creates nothing, deploys nothing.
 *
 *   npx tsx src/spikes/_probe_flow_coverage.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { translateFlow, integrationNameForFlow } from '../services/flowMapper.js';

await connectMongo();
// agentIRCache is migration-scoped, so every read is keyed by appUserId -- this probe
// reports across whatever this operator's own cache holds, never across tenants.
const rows = await getDb().collection('agentIRCache').find({}).toArray();

let agents = 0, withFlows = 0, flows = 0, steps = 0, translated = 0;
const byStatus = new Map<string, number>();
const reasons = new Map<string, number>();
for (const row of rows) {
  agents++;
  const list = (row as any).ir?.flows ?? [];
  if (!list.length) continue;
  withFlows++;
  for (const flow of list) {
    flows++;
    const r = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
    const tasks = (r.integrationDefinition as any)?.taskConfigs?.length ?? 0;
    const n = flow.actions.length;
    steps += n;
    // The translator's own summary note carries the authoritative count; the task count is
    // not it (one action can compile to several tasks, and the trigger is not an action).
    const summary = r.fidelityNotes.find((x: any) => /step\(s\) translated/.test(x.detail ?? ''));
    const m = summary?.detail?.match(/(\d+) of (\d+) step/);
    const ok = m ? Number(m[1]) : n - r.fidelityNotes.filter((x: any) => x.status !== 'migrated').length;
    translated += ok;
    for (const note of r.fidelityNotes) {
      byStatus.set(note.status, (byStatus.get(note.status) ?? 0) + 1);
      if (note.status === 'mapped') continue;
      // Strip the instance-specific tail so two steps failing the same way group together.
      const shape = String(note.detail ?? '')
        .replace(/"[^"]*"/g, '"X"').replace(/:.*$/, '').trim().slice(0, 104);
      reasons.set(shape, (reasons.get(shape) ?? 0) + 1);
    }
    console.log(`${String(ok).padStart(3)}/${String(n).padEnd(3)} steps  ${String(tasks).padStart(3)} tasks  ${flow.name}`);
  }
}
// Group refusals by SHAPE, not instance: twelve flows yield a handful of distinct
// reasons, and the shape is what names the capability to build next.
console.log('');
console.log('why steps did not translate:');
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${why}`);
}
console.log(`\n${agents} cached agent(s), ${withFlows} with flows, ${flows} flow(s)`);
console.log(`steps translated: ${translated}/${steps}${steps ? ` (${Math.round((translated / steps) * 100)}%)` : ''}`);
for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${s}`);
process.exit(0);
