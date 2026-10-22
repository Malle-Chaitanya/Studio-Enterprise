/**
 * Ground truth check: which connectors does the REAL extracted "Employee Helpdesk agent"
 * actually reference in its own tools — not assumed, not inferred from the decision screen.
 * Same method as _diag_check_real_operationids_this_agent.ts (the Office 365 Users pilot) —
 * query stagedAgents directly, because a secondary source has already been wrong once this
 * project.
 *
 *   npx tsx src/spikes/_diag_check_employee_helpdesk_connectors.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

await connectMongo();

const db = getDb(config.CSGE_DB);
const docs = await db
  .collection('stagedAgents')
  .find({ 'mapped.ir.name': { $regex: /helpdesk/i } })
  .toArray();

if (docs.length === 0) {
  console.log('No staged agent matching "helpdesk" found. Listing all staged agent names instead:');
  const all = await db.collection('stagedAgents').find({}, { projection: { 'mapped.ir.name': 1 } }).toArray();
  for (const d of all) console.log(' -', (d as any).mapped?.ir?.name ?? d._id);
  process.exit(0);
}

for (const doc of docs) {
  const ir = (doc as any).mapped?.ir;
  console.log(`\n=== ${ir?.name ?? '(unnamed)'} (_id=${(doc as any)._id}) ===`);
  const tools = ir?.agentTools ?? [];
  console.log(`Total agentTools: ${tools.length}`);

  const byConnector = new Map<string, Array<{ name: string; operationId: string }>>();
  for (const t of tools) {
    if (!t.connectorId) continue;
    const list = byConnector.get(t.connectorId) ?? [];
    list.push({ name: t.displayName || t.name, operationId: t.operationId });
    byConnector.set(t.connectorId, list);
  }

  const GOOGLE_SIX = [
    'shared_googledrive', 'shared_googlesheet', 'shared_googlecontacts',
    'shared_googlecalendar', 'shared_googletasks', 'shared_gmail',
  ];

  console.log('\nConnectors this agent actually references:');
  for (const [connectorId, ops] of byConnector) {
    const flag = GOOGLE_SIX.includes(connectorId) ? '  <- one of the 6 Google connectors' : '';
    console.log(`  ${connectorId} (${ops.length} tool(s))${flag}`);
  }

  console.log('\nOf the 6 Google connectors specifically:');
  for (const connectorId of GOOGLE_SIX) {
    const ops = byConnector.get(connectorId);
    if (!ops) {
      console.log(`  ${connectorId}: NOT referenced by this agent`);
    } else {
      console.log(`  ${connectorId}: ${ops.length} tool(s) — ${ops.map((o) => `${o.name} (${o.operationId})`).join(', ')}`);
    }
  }
}

process.exit(0);
