/** What would migrating the real "Email Manager" agent actually produce, per tool?
 *  Read-only. cd server && npx tsx src/spikes/_diag_email_manager_plan.ts */
import { findEquivalence, describeEquivalence } from '../connectors/equivalence.js';

const OPS = ['SendEmailV2', 'GetEventsCalendarViewV3', 'GetEmailsV3'];
for (const op of OPS) {
  const e = findEquivalence('outlook', op);
  console.log(`\n=== ${op} ===`);
  if (!e) { console.log('  NOT IN THE TABLE — unmapped, would surface as needs-review'); continue; }
  console.log(`  label    : ${e.label}`);
  console.log(`  fidelity : ${e.fidelity}`);
  console.log(`  gmail    : ${e.target ? `${e.target.capability} tool=${e.tool ?? '-'} proven=${!!e.verified}` : 'none'}`);
  console.log(`  graph    : ${e.graph ? `${e.graph.capability} tool=${e.graph.tool ?? '-'} proven=${!!e.graph.verified}` : 'none'}`);
  console.log(`  sentence : ${describeEquivalence(e)}`);
}
process.exit(0);
