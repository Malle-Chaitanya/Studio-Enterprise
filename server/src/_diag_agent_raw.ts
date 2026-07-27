/** Fetch one agent's full JSON with NO mongo dependency (token via SA key +
 *  GOOGLE_IMPERSONATE_EMAIL). Shows every real field the agent object has.
 *   npx tsx src/_diag_agent_raw.ts <project> <engineId> <agentId> */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) throw new Error('usage: _diag_agent_raw.ts <project> <engineId> <agentId>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const url = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`GET agent → ${r.status}\n`);
  const text = await r.text();
  try {
    // Print top-level keys first (the "what fields exist" answer), then trimmed body.
    const j = JSON.parse(text);
    console.log('TOP-LEVEL FIELDS:', Object.keys(j).join(', '));
    if (j.lowCodeAgentDefinition) console.log('lowCodeAgentDefinition FIELDS:', Object.keys(j.lowCodeAgentDefinition).join(', '));
    console.log('\n--- full JSON (instruction truncated) ---');
    if (j.lowCodeAgentDefinition?.nodes) {
      for (const n of j.lowCodeAgentDefinition.nodes) {
        if (n.llmAgentNode?.instruction && n.llmAgentNode.instruction.length > 200)
          n.llmAgentNode.instruction = n.llmAgentNode.instruction.slice(0, 200) + `…[${n.llmAgentNode.instruction.length} chars total]`;
      }
    }
    console.log(JSON.stringify(j, null, 2).slice(0, 3000));
  } catch {
    console.log(text.slice(0, 2000));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
