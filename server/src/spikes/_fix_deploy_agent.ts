/**
 * Fix: PATCH our Confluence agent with correct model + deployedNodes,
 * then publish (poll Operation until done).
 *
 * Usage: cd server && npx tsx src/spikes/_fix_deploy_agent.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_ID     = '8980160511526117673';
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';
const OPS_HOST     = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentUrl = `${assistantBase}/agents/${AGENT_ID}`;

// ── 1. Read current definition ────────────────────────────────────────────────
console.log('Reading current agent…');
const agent = await getAgent(dest, saToken, AGENT_ID);
if (!agent) { console.error('getAgent failed'); process.exit(1); }
const files = readAgentFiles(agent);
const lcd = agent.lowCodeAgentDefinition as Record<string, unknown>;
console.log(`  state: ${agent.state}  agentFiles: ${files.length}  deployedNodes: ${(lcd.deployedNodes as unknown[])?.length ?? 0}`);

// ── 2. Build the corrected node ───────────────────────────────────────────────
const DISPLAY_NAME = agent.displayName as string;
const INSTRUCTION  = (lcd.nodes as Array<Record<string, unknown>>)[0]?.llmAgentNode
  ? ((lcd.nodes as Array<Record<string, unknown>>)[0].llmAgentNode as Record<string, unknown>).instruction
  : 'You are a helpful assistant. Answer questions from the attached Confluence knowledge files.';

const node = {
  id: 'root_agent',
  displayName: DISPLAY_NAME,
  llmAgentNode: {
    description: (agent.description as string) ?? '',
    model: 'gemini-2.5-flash',       // match working agent model
    instruction: INSTRUCTION,
    subAgentIds: [],
    selectedTools: { tool: [{ name: 'googleSearch' }] },
  },
};

// deployedNodes must be populated for Preview/serving to work
const patchBody = {
  lowCodeAgentDefinition: {
    rootAgentId: 'root_agent',
    nodes: [node],
    deployedNodes: [node],            // <-- key fix: working agent has this populated
    agentFiles: files,
    draftDisplayName: DISPLAY_NAME,
    draftDescription: agent.description ?? '',
    draftStarterPrompts: (lcd.draftStarterPrompts as unknown[]) ?? [],
    draftIcon: { content: '' },
    draftSchedules: [],
    deployedSchedules: [],
  },
};

// ── 3. PATCH ─────────────────────────────────────────────────────────────────
console.log('\nPATCHing agent (model + deployedNodes)…');
const patchRes = await fetch(
  `${agentUrl}?updateMask=lowCodeAgentDefinition`,
  {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  },
);
const patchText = await patchRes.text();
if (!patchRes.ok) {
  console.error(`PATCH failed ${patchRes.status}: ${patchText.slice(0, 400)}`);
  process.exit(1);
}
console.log(`  ✓ PATCH ok (${patchRes.status})`);

// ── 4. Publish ────────────────────────────────────────────────────────────────
console.log('\nPublishing…');
const pubRes = await fetch(`${agentUrl}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const pubText = await pubRes.text();
console.log(`  publish status: ${pubRes.status}`);

let pubJson: Record<string, unknown> = {};
try { pubJson = JSON.parse(pubText); } catch { /* plain text */ }
console.log(`  publish body: ${JSON.stringify(pubJson).slice(0, 400)}`);

// If it's a long-running operation, poll until done
const opName = pubJson.name as string | undefined;
if (opName && opName.includes('/operations/')) {
  console.log(`  Polling operation: ${opName}`);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const opRes = await fetch(`${OPS_HOST}/${opName}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const opJson = await opRes.json() as Record<string, unknown>;
    console.log(`  poll ${i + 1}: done=${opJson.done} ${opJson.error ? 'ERROR: ' + JSON.stringify(opJson.error) : ''}`);
    if (opJson.done) break;
  }
}

// ── 5. Share ─────────────────────────────────────────────────────────────────
console.log('\nSharing (ALL_USERS)…');
const shareRes = await fetch(`${agentUrl}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`  share status: ${shareRes.status}`);

// ── 6. Re-read state ─────────────────────────────────────────────────────────
console.log('\nRe-reading state…');
const after = await getAgent(dest, saToken, AGENT_ID);
const afterLcd = after?.lowCodeAgentDefinition as Record<string, unknown> | undefined;
console.log(`  state: ${after?.state}`);
console.log(`  deployedNodes: ${(afterLcd?.deployedNodes as unknown[])?.length ?? 0}`);
console.log(`  agentFiles: ${readAgentFiles(after ?? {}).length}`);
