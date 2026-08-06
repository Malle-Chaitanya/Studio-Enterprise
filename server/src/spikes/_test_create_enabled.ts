/**
 * Test: create an agent with state=ENABLED + deployedNodes in the body.
 * If this results in ENABLED state immediately, we know the right create body.
 * Usage: cd server && npx tsx src/spikes/_test_create_enabled.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const saToken = await getSaToken('mia@cloudfuze.com');
const dest    = await resolveDestination('sonorous-lightning-t224x', saToken);
const HOST    = 'https://discoveryengine.googleapis.com/v1alpha';
const assistantBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

// First: search for existing test agent to avoid creating duplicates
const DISPLAY_NAME = 'MinimalTestAgent-ENABLED';
const listRes = await fetch(`${assistantBase}/agents?pageSize=100`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const listJson = await listRes.json() as { agents?: Array<{ name: string; displayName: string; state?: string }> };
const existing = (listJson.agents ?? []).find(a => a.displayName === DISPLAY_NAME);
if (existing) {
  const id = existing.name.split('/').pop();
  console.log(`Found existing: ${id}  state=${existing.state}`);
  // Delete it so we can test fresh creation
  const delRes = await fetch(`${assistantBase}/agents/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log(`Deleted: ${delRes.status}`);
}

// Create with state=ENABLED + deployedNodes
console.log('\nCreating agent with state=ENABLED + deployedNodes…');
const node = {
  id: 'root',
  displayName: DISPLAY_NAME,
  llmAgentNode: {
    description: 'Minimal test',
    model: 'gemini-2.5-flash',
    instruction: 'You are a helpful assistant. Answer questions concisely.',
    selectedTools: { tool: [{ name: 'googleSearch' }] },
  },
};

const body = {
  displayName: DISPLAY_NAME,
  description: 'Minimal test to verify ENABLED state on creation',
  state: 'ENABLED',   // try setting ENABLED at create time
  sharingConfig: { scope: 'ALL_USERS' },
  lowCodeAgentDefinition: {
    rootAgentId: 'root',
    nodes: [node],
    deployedNodes: [node],   // populate deployedNodes at create time
    agentFiles: [],
    draftDisplayName: DISPLAY_NAME,
    draftDescription: 'Minimal test',
    draftStarterPrompts: [],
    draftIcon: { content: '' },
    draftSchedules: [],
    deployedSchedules: [],
  },
};

const createRes = await fetch(`${assistantBase}/agents`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const createJson = await createRes.json() as Record<string, unknown>;
console.log(`Create status: ${createRes.status}`);
console.log(`  state: ${createJson.state}`);
console.log(`  id:    ${(createJson.name as string)?.split('/').pop()}`);
const lcd = createJson.lowCodeAgentDefinition as Record<string, unknown> | undefined;
console.log(`  deployedNodes: ${(lcd?.deployedNodes as unknown[])?.length ?? 0}`);

// Try publish immediately after create
if (createRes.ok) {
  const agentId = (createJson.name as string).split('/').pop()!;
  console.log(`\nPublishing new agent ${agentId}…`);
  const pubRes = await fetch(`${assistantBase}/agents/${agentId}:publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const pubJson = await pubRes.json() as Record<string, unknown>;
  const pubAgent = pubJson.agent as Record<string, unknown> | undefined;
  console.log(`  publish status: ${pubRes.status}  state=${pubAgent?.state ?? pubJson.state ?? '?'}`);

  // Wait 3s then check
  await new Promise(r => setTimeout(r, 3000));
  const checkRes = await fetch(`${assistantBase}/agents/${agentId}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const checkJson = await checkRes.json() as Record<string, unknown>;
  console.log(`  after 3s: state=${checkJson.state}`);
}
