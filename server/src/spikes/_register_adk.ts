/** Register a deployed reasoning engine into the engine with the REAL migrated
 *  name + description (from the spec file), using the tool's registerAdkAgent().
 *   npx tsx src/_register_adk.ts <project> <engineId> <reasoningEngine> <specFile> [cid] */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getSaToken } from './auth/google.js';
import { registerAdkAgent } from './services/adkDeployer.js';

const [PROJECT, ENGINE, REASONING, SPEC, CID] = process.argv.slice(2);

async function main() {
  if (!PROJECT || !ENGINE || !REASONING || !SPEC) throw new Error('usage: _register_adk.ts <project> <engineId> <reasoningEngine> <specFile> [cid]');
  const spec = JSON.parse(readFileSync(SPEC, 'utf-8')) as { displayName: string; description: string };
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const dest = { project: PROJECT, engine: ENGINE, assistant: 'default_assistant' };
  const res = await registerAdkAgent(dest, token, {
    reasoningEngine: REASONING,
    displayName: spec.displayName,
    description: spec.description,
  });
  console.log(`register -> registered=${res.registered} state=${res.state} id=${res.agentId}`);
  if (res.error) console.log(`error: ${res.error}`);
  if (res.registered && res.state === 'ENABLED') {
    console.log(`\n✅ FULLY AUTOMATED: migrated agent deployed + registered → ENABLED (gallery-visible).`);
    if (CID) console.log(`Direct link: https://vertexaisearch.cloud.google.com/home/cid/${CID}/r/agent/${res.agentId}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
