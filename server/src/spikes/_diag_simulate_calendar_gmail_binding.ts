import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import type { AgentIR } from '../types.js';

await connectMongo();
const db = getDb(config.CSGE_DB);

const doc = await db.collection('stagedAgents').findOne({ _id: new ObjectId('6ad9eaac28a9cce89dbcf2b5') });
if (!doc) {
  console.log('doc not found');
  process.exit(1);
}
const ir = (doc as any).mapped?.ir as AgentIR;
console.log('Agent:', ir.name, '| total tools:', ir.agentTools?.length);

const { byConnector, notes } = await buildBoundToolSpecs(ir, undefined, {});

for (const connectorId of ['shared_googlecalendar', 'shared_gmail']) {
  const specs = byConnector.get(connectorId) ?? [];
  console.log(`\n=== ${connectorId}: ${specs.length} bound tool spec(s) ===`);
  for (const s of specs) {
    console.log(`  toolName=${s.toolName} | operationId=${s.operationId} | method=${s.method} | chain=${!!s.chain} | modelArgs=${s.modelArgs.map((a) => a.name).join(',')}`);
  }
}

console.log('\n=== Fidelity notes mentioning delete/Delete ===');
for (const n of notes) {
  const text = JSON.stringify(n);
  if (/delete/i.test(text)) console.log(text);
}
process.exit(0);
