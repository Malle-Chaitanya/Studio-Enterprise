/** Does the fix hold on the REAL agent that exposed both bugs? Two checks, because staged rows
 *  carry the classification from the run that staged them:
 *    1. the staged IR as-is  — what an OLD row does now (the fallback path)
 *    2. re-classified        — what the NEXT run will do (the fixed path) */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import { classifyKnowledgeSource } from '../services/knowledgeClassifier.js';
import type { AgentIR } from '../types.js';

await connectMongo();
const row = (await getDb().collection('stagedAgents').find({ sourceId: 'ca57b355-d08b-f111-8076-0022480b19e9' }).sort({ _id: -1 }).limit(1).next()) as Record<string, any> | null;
const ir = row!.mapped.ir as AgentIR;

console.log(`agent: ${row!.displayName}\n`);
console.log(`1. staged row as-is        -> ${[...agentConnectorIds(ir)].join(', ') || '(none)'}`);

const refreshed = {
  ...ir,
  knowledgeSources: ir.knowledgeSources.map((k) => ({
    ...k,
    classification: classifyKnowledgeSource({
      kind: k.kind,
      description: (k as { description?: string }).description,
      references: (k as { references?: string[] }).references,
      file: (k as { file?: { name?: string; sizeBytes?: number } }).file,
    }),
  })),
} as AgentIR;
console.log(`2. re-classified (next run) -> ${[...agentConnectorIds(refreshed)].join(', ') || '(none)'}`);
console.log('\nper source, re-classified:');
for (const k of refreshed.knowledgeSources) {
  console.log(`   ${String(k.kind).padEnd(34)} ${String(k.name).padEnd(34)} needs=${k.classification?.requiresConnectorId ?? '(none)'}`);
}
process.exit(0);
