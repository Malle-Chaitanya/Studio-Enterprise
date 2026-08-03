/** Dump the FULL instruction text stored on a deployed agent (no truncation) so
 *  fidelity can be verified. Writes the complete text to <outFile> and prints
 *  length + first/last 400 chars as proof it's complete.
 *   npx tsx src/_dump_instruction.ts <project> <engineId> <agentId> <outFile> */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, AGENT, OUT] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;

async function main() {
  if (!PROJECT || !ENGINE || !AGENT || !OUT) throw new Error('usage: _dump_instruction.ts <project> <engineId> <agentId> <outFile>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const j = (await (await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
    displayName?: string;
    lowCodeAgentDefinition?: { nodes?: { llmAgentNode?: { instruction?: string } }[] };
  };
  const instr = j.lowCodeAgentDefinition?.nodes?.[0]?.llmAgentNode?.instruction ?? '';
  writeFileSync(OUT, instr, 'utf-8');
  console.log(`agent: ${j.displayName}`);
  console.log(`instruction length: ${instr.length} chars`);
  console.log(`lines: ${instr.split(/\r?\n/).length}`);
  console.log(`\n----- FIRST 400 chars -----\n${instr.slice(0, 400)}`);
  console.log(`\n----- LAST 400 chars -----\n${instr.slice(-400)}`);
  console.log(`\n(full exact text written to: ${OUT})`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
