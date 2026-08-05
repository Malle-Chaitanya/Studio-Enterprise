// Read-only diagnostic: list AgentIR.topics for one agent by name (confirm
// which source Topics fed the compiled "Conversation procedures" block).
// Usage: cd server && npx tsx src/spikes/_diag_list_topics.ts "<agent name>"
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';
import type { AgentIR } from '../types.js';

async function main() {
  const nameQuery = process.argv[2];
  if (!nameQuery) {
    console.error('Usage: npx tsx src/spikes/_diag_list_topics.ts "<agent name>"');
    process.exit(1);
  }
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const docs = await db
    .collection<{ ir: AgentIR }>('agentIRCache')
    .find({ 'ir.name': { $regex: nameQuery, $options: 'i' } })
    .toArray();
  for (const doc of docs) {
    console.log(`Agent: ${doc.ir.name}  (${doc.ir.topics.length} topics)`);
    for (const t of doc.ir.topics as any[]) {
      console.log(`  - name: ${t.name}`);
      console.log(`    triggerPhrases: ${JSON.stringify(t.triggerPhrases ?? t.trigger ?? [])}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
