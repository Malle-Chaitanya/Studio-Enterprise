// Read-only diagnostic: compare source-extracted vs migrated instruction/description
// for one agent by name, pulled from the agentIRCache cache.
// Usage: cd server && npx tsx src/spikes/_diag_compare_instructions.ts "<agent name>"
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';
import type { AgentIR, MappedAgent } from '../types.js';

async function main() {
  const nameQuery = process.argv[2];
  if (!nameQuery) {
    console.error('Usage: npx tsx src/spikes/_diag_compare_instructions.ts "<agent name>"');
    process.exit(1);
  }

  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const docs = await db
    .collection<{ ir: AgentIR; mapped: MappedAgent; sourceId: string; envUrl: string; extractedAt: Date }>('agentIRCache')
    .find({ 'ir.name': { $regex: nameQuery, $options: 'i' } })
    .toArray();

  if (docs.length === 0) {
    console.log(`No agentIRCache entries matched name ~ "${nameQuery}"`);
    process.exit(0);
  }

  for (const doc of docs) {
    console.log('='.repeat(80));
    console.log(`sourceId: ${doc.sourceId}  envUrl: ${doc.envUrl}  extractedAt: ${doc.extractedAt}`);
    console.log('-'.repeat(80));
    console.log('SOURCE (extracted from Dataverse) — AgentIR.description:');
    console.log(doc.ir.description || '(empty)');
    console.log('\nSOURCE (extracted from Dataverse) — AgentIR.instructions:');
    console.log(doc.ir.instructions || '(empty)');
    console.log('-'.repeat(80));
    console.log('MIGRATED (mapped for Gemini) — MappedAgent.description:');
    console.log(doc.mapped.description || '(empty)');
    console.log('\nMIGRATED (mapped for Gemini) — MappedAgent.instruction:');
    console.log(doc.mapped.instruction || '(empty)');
    console.log('-'.repeat(80));
    console.log('FidelityNotes:');
    for (const note of doc.mapped.fidelityNotes) {
      console.log(`  [${note.status}] ${note.component}: ${note.detail}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
