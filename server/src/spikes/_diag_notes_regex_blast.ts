/** How many agents get a connector wired ONLY by the /confluence/i notes regex? Counter-
 *  factual per agent: ids as shipped vs ids with notes blanked. Distinct agents, not rows. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import type { AgentIR } from '../types.js';

await connectMongo();
// NEWEST row per agent. Natural order gives the OLDEST, which is a different IR — an
// earlier run's classification had no notes, so the first version of this spike reported
// zero affected agents while the single-agent proof showed the opposite.
const staged = (await getDb().collection('stagedAgents').find({}).sort({ _id: -1 }).toArray()) as Array<Record<string, any>>;
const seen = new Set<string>();
const affected: Array<{ name: string; note: string }> = [];
let agents = 0;
for (const row of staged) {
  const key = String(row.sourceId ?? row.displayName ?? row._id);
  if (seen.has(key)) continue;
  seen.add(key);
  const ir = row.mapped?.ir as AgentIR | undefined;
  if (!ir?.knowledgeSources) continue;
  agents++;
  const withNotes = agentConnectorIds(ir);
  const blanked = agentConnectorIds({
    ...ir,
    knowledgeSources: ir.knowledgeSources.map((k) => ({
      ...k,
      classification: k.classification ? { ...k.classification, notes: [] } : k.classification,
    })),
  } as AgentIR);
  if (withNotes.has('shared_confluence') && !blanked.has('shared_confluence')) {
    // Print the offending phrase so a human can see whether it AFFIRMS or DENIES Confluence.
    const notes = ir.knowledgeSources.flatMap((k) => k.classification?.notes ?? []).join(' ');
    affected.push({ name: String(row.displayName), note: (notes.match(/.{0,40}confluence.{0,40}/i) ?? [''])[0] });
  }
}
console.log(`${agents} agent(s) examined; ${affected.length} got shared_confluence ONLY from the notes regex\n`);
for (const a of affected) console.log(`  ${a.name.padEnd(34)} ...${a.note}...`);
process.exit(0);
