/**
 * What exactly do real agents call on Jira, and with what arguments?
 *
 * `ListResources` and `mcp_JiraIssueManagement` are the two biggest unjudged operations
 * (15 and 34 agents) and neither name says what it does. Reading the captured tool
 * definitions is the only way to judge them without guessing.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const staged = await db.collection('stagedAgents').find({}).toArray();

const byOp = new Map<string, Array<Record<string, unknown>>>();
for (const row of staged as Array<Record<string, unknown>>) {
  const mapped = row.mapped as { ir?: { agentTools?: Array<Record<string, unknown>> } } | undefined;
  for (const t of mapped?.ir?.agentTools ?? []) {
    if (!String(t.connectorId ?? '').includes('jira')) continue;
    const op = String(t.operationId ?? '');
    byOp.set(op, [...(byOp.get(op) ?? []), t]);
  }
}
for (const [op, tools] of [...byOp].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n=== ${op} — ${tools.length} agent(s) ===`);
  const t = tools[0];
  // Print the whole captured tool once: the fields differ per operation and guessing which
  // matter is how a mapping ends up plausible and wrong.
  console.log(JSON.stringify(t, null, 1).slice(0, 900));
}
process.exit(0);
