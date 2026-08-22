/**
 * Which Microsoft connector operations do real agents ACTUALLY call?
 *
 * The spec's blocked-operation count (340) is the SWAGGER surface — every operation the
 * connector exposes, whether or not a human ever used it. Mapping against that number is
 * how a three-week job becomes a three-month one. This reads what the customer's own
 * staged agents reference, so the mapping work is ordered by real demand.
 *
 * Output is the Week 1 work queue: each blocked operation, how many agents want it, and
 * which agents break without it.
 *
 * Read-only. Run: cd server && npx tsx src/spikes/_diag_ms_op_usage.ts [appUserId]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb, isDbConnected } from '../db/core.js';
import { VENDOR_BINDINGS } from '../connectors/operationBinding.js';
import type { AgentToolIR } from '../types.js';

/** Microsoft-published connectors, by the ids we see in Copilot payloads. */
const MS_CONNECTORS = [
  'shared_office365',
  'shared_onedrive',
  'shared_sharepointonline',
  'shared_teams',
  'shared_commondataserviceforapps',
  'shared_dynamicscrmonline',
  'shared_powerplatformadminv2',
  'shared_planner',
];

interface Row {
  mapped?: { ir?: { name?: string; agentTools?: AgentToolIR[] } };
  sourceName?: string;
  appUserId?: string;
  envUrl?: string;
}

async function main(): Promise<void> {
  await connectMongo();
  if (!isDbConnected()) {
    console.error('Mongo not connected. Start it:');
    console.error('  docker start csge-mongodb   (or docker run … mongo:7.0 on 27019)');
    process.exit(1);
  }

  // Tenant-scoped when an appUserId is given; unscoped only for local diagnostics against
  // a dev database, never a shared one.
  const appUserId = process.argv[2];
  const filter = appUserId ? { appUserId } : {};
  const rows = (await getDb().collection('stagedAgents').find(filter).toArray()) as unknown as Row[];

  const usage = new Map<string, { count: number; agents: Set<string> }>();
  const perConnector = new Map<string, Set<string>>();
  let toolsSeen = 0;

  for (const r of rows) {
    const agentName = r.mapped?.ir?.name ?? r.sourceName ?? '(unnamed)';
    for (const t of r.mapped?.ir?.agentTools ?? []) {
      if (!t.connectorId || !MS_CONNECTORS.includes(t.connectorId)) continue;
      toolsSeen++;
      const key = `${t.connectorId}|${t.operationId ?? '(no operationId)'}`;
      if (!usage.has(key)) usage.set(key, { count: 0, agents: new Set() });
      const u = usage.get(key)!;
      u.count++;
      u.agents.add(agentName);
      if (!perConnector.has(t.connectorId)) perConnector.set(t.connectorId, new Set());
      perConnector.get(t.connectorId)!.add(agentName);
    }
  }

  console.log(`staged agents scanned: ${rows.length}${appUserId ? ` (appUserId=${appUserId})` : ' (ALL tenants — dev only)'}`);
  console.log(`Microsoft connector tool references: ${toolsSeen}\n`);

  if (!usage.size) {
    console.log('No Microsoft connector operations referenced by any staged agent.');
    console.log('That is itself the finding: the mapping work has no demand in this dataset.');
    process.exit(0);
  }

  // Split by what the binding table says today. `proxy-only` is the work queue.
  const blocked: Array<[string, { count: number; agents: Set<string> }]> = [];
  const works: Array<[string, { count: number; agents: Set<string> }]> = [];
  for (const [key, u] of usage) {
    const connectorId = key.split('|')[0];
    const binding = VENDOR_BINDINGS[connectorId];
    (binding?.pathStyle === 'proxy-only' ? blocked : works).push([key, u]);
  }

  const line = ([key, u]: [string, { count: number; agents: Set<string> }]): string => {
    const [conn, op] = key.split('|');
    return `  ${String(u.count).padStart(3)}×  ${conn.replace('shared_', '').padEnd(28)} ${op.padEnd(34)} ${[...u.agents].slice(0, 3).join(', ')}${u.agents.size > 3 ? ` +${u.agents.size - 3}` : ''}`;
  };

  console.log('═══ BLOCKED — these need a hand-written vendor mapping ═══');
  console.log('    (ordered by demand: fix the top of this list first)\n');
  blocked.sort((a, b) => b[1].count - a[1].count).forEach((e) => console.log(line(e)));
  if (!blocked.length) console.log('  (none — every referenced MS operation already binds)');

  console.log('\n═══ ALREADY BINDS — no mapping work needed ═══\n');
  works.sort((a, b) => b[1].count - a[1].count).forEach((e) => console.log(line(e)));
  if (!works.length) console.log('  (none)');

  console.log('\n═══ AGENTS AT RISK, per connector ═══\n');
  for (const [conn, agents] of [...perConnector.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const style = VENDOR_BINDINGS[conn]?.pathStyle ?? 'unknown';
    console.log(`  ${conn.padEnd(38)} ${style.padEnd(12)} ${agents.size} agent(s)`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log(
    `WORK QUEUE: ${blocked.length} distinct operation(s) actually in demand, ` +
      `against a swagger surface of 340.`,
  );
  console.log('Map these, in this order. Everything below the fold is theoretical demand.');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', (e as Error).message);
  process.exit(1);
});
