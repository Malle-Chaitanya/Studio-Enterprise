/** Test: can we edit a LOW-CODE agent's INSTRUCTION (its behavior) in place via
 *  agents.patch? If yes, low-code agents are fully editable via API (no redeploy).
 *   npx tsx src/spikes/_diag_patch_instruction.ts <project> <engineId> <agentId> */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;

interface LcAgent { lowCodeAgentDefinition?: { nodes?: { llmAgentNode?: { instruction?: string } }[] } }

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) throw new Error('usage: _diag_patch_instruction.ts <project> <engineId> <agentId>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const cur = (await (await fetch(BASE, { headers: h })).json()) as LcAgent;
  const def = cur.lowCodeAgentDefinition;
  const node = def?.nodes?.[0]?.llmAgentNode;
  if (!node) { console.log('not a low-code agent (no llmAgentNode) — skipping'); process.exit(0); }
  const orig = node.instruction ?? '';
  const marker = '\n\n[edit-test marker ' + orig.length + 'ch]';
  console.log(`BEFORE instruction length: ${orig.length}`);

  // Append a harmless marker and PATCH the whole lowCodeAgentDefinition back.
  node.instruction = orig + marker;
  const r = await fetch(`${BASE}?updateMask=lowCodeAgentDefinition`, { method: 'PATCH', headers: h, body: JSON.stringify({ lowCodeAgentDefinition: def }) });
  const text = await r.text();
  console.log(`PATCH updateMask=lowCodeAgentDefinition -> ${r.status}`);
  if (!r.ok) { console.log(text.replace(/\s+/g, ' ').slice(0, 400)); process.exit(0); }

  const after = (await (await fetch(BASE, { headers: h })).json()) as LcAgent;
  const newInstr = after.lowCodeAgentDefinition?.nodes?.[0]?.llmAgentNode?.instruction ?? '';
  console.log(`AFTER instruction length: ${newInstr.length}`);
  const ok = newInstr.endsWith(marker.trim()) || newInstr.length > orig.length;
  console.log(ok ? '\n✅ INSTRUCTION EDITABLE IN PLACE — low-code behavior is patchable via API (no redeploy).'
                 : '\n⚠️ instruction unchanged — behavior may not be patchable this way.');

  // Revert to the original instruction so we leave the agent as we found it.
  if (ok) {
    node.instruction = orig;
    const rev = await fetch(`${BASE}?updateMask=lowCodeAgentDefinition`, { method: 'PATCH', headers: h, body: JSON.stringify({ lowCodeAgentDefinition: def }) });
    console.log(`(reverted instruction: ${rev.status})`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
