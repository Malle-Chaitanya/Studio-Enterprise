/** Pull a migrated low-code agent's real content and write an ADK spec file
 *  (for scripts/adk_deploy.py). Proves fidelity carries into the ADK path.
 *   npx tsx src/_prep_adk_spec.ts <project> <engineId> <agentId> <outFile> */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getSaToken } from './auth/google.js';
import { buildAdkSpec } from './services/adkDeployer.js';
import type { AgentIR } from './types.js';

const [PROJECT, ENGINE, AGENT, OUT] = process.argv.slice(2);

async function main() {
  if (!PROJECT || !ENGINE || !AGENT || !OUT) throw new Error('usage: _prep_adk_spec.ts <project> <engineId> <agentId> <outFile>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await r.json()) as {
    displayName?: string; description?: string;
    lowCodeAgentDefinition?: { nodes?: { llmAgentNode?: { instruction?: string; selectedTools?: { tool?: { name?: string }[] } } }[] };
  };
  const node = j.lowCodeAgentDefinition?.nodes?.[0]?.llmAgentNode;
  const instruction = node?.instruction ?? '';
  const usesSearch = (node?.selectedTools?.tool ?? []).some((t) => t.name === 'googleSearch');

  // Reuse the tool's real spec builder to prove parity with the production path.
  const ir = {
    name: j.displayName ?? 'Migrated Agent',
    description: j.description ?? '',
    instructions: instruction,
    capabilities: { webBrowsing: usesSearch, codeInterpreter: false },
  } as AgentIR;
  const spec = buildAdkSpec(ir);
  writeFileSync(OUT, JSON.stringify(spec, null, 2), 'utf-8');
  console.log(`wrote ${OUT}: name=${spec.name} model=${spec.model} instr=${spec.instruction.length}ch tools=[${spec.tools.join(',')}]`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
