/** Prove WHICH of the three clauses in agentConnectorIds wired shared_confluence onto the
 *  Knowledge Assistant. If it is only the notes regex, the note that says "no
 *  Confluence-matching description" is what added Confluence — a negation read as a match. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import type { AgentIR } from '../types.js';

await connectMongo();
const row = (await getDb().collection('stagedAgents').find({ sourceId: 'ca57b355-d08b-f111-8076-0022480b19e9' }).sort({ _id: -1 }).limit(1).next()) as Record<string, any> | null;
const ir = row!.mapped.ir as AgentIR;

console.log(`ids as shipped: ${[...agentConnectorIds(ir)].join(', ') || '(none)'}\n`);
for (const ks of ir.knowledgeSources) {
  const notes = ks.classification?.notes?.join(' ') ?? '';
  console.log(`${String(ks.kind).padEnd(34)} ${String(ks.name)}`);
  console.log(`   strategy            = ${String(ks.classification?.strategy)}`);
  console.log(`   confluenceSpaceNames= ${JSON.stringify(ks.confluenceSpaceNames ?? [])}`);
  console.log(`   notes match /confluence/i = ${/confluence/i.test(notes)}`);
  const m = notes.match(/.{0,45}confluence.{0,45}/i);
  if (m) console.log(`   matched text        = ...${m[0]}...`);
}

// Remove ONLY the notes clause and see what survives — the counterfactual, not an argument.
const stripped = {
  ...ir,
  knowledgeSources: ir.knowledgeSources.map((k) => ({
    ...k,
    classification: k.classification ? { ...k.classification, notes: [] } : k.classification,
  })),
} as AgentIR;
console.log(`\nids with notes blanked: ${[...agentConnectorIds(stripped)].join(', ') || '(none)'}`);
process.exit(0);
