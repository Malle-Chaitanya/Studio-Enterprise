/**
 * Proves the REAL pipeline function (`buildBoundToolSpecs`, the one orchestrator.ts calls on
 * every live migration) actually goes through the new dynamic catalog for Office 365 Users —
 * not just the standalone lookup function in isolation.
 *
 *   npx tsx src/spikes/_test_bound_tool_spec_office365users.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import type { AgentIR, AgentToolIR } from '../types.js';

await connectMongo();

const tools: Partial<AgentToolIR>[] = [
  {
    kind: 'connector',
    name: 'Get a colleague profile',
    connectorId: 'shared_office365users',
    operationId: 'GetUserV2',
    inputs: [],
  },
  {
    kind: 'connector',
    name: 'Get my own profile',
    connectorId: 'shared_office365users',
    operationId: 'MyProfile_V2',
    inputs: [],
  },
];

const ir = {
  name: 'TestAgent',
  displayName: 'Test Agent',
  description: '',
  instructions: '',
  agentTools: tools,
  topics: [],
  knowledgeSources: [],
  unmapped: {},
} as unknown as AgentIR;

const { byConnector, notes } = await buildBoundToolSpecs(ir, undefined);

console.log('--- Deployable tool specs built (what would actually be sent to the deployed agent) ---');
for (const [connectorId, specs] of byConnector) {
  console.log(`\n${connectorId}:`);
  for (const s of specs) {
    console.log(`  ${s.toolName}: ${s.method} ${s.urlTemplate}`);
    console.log(`    model args: ${s.modelArgs.map((a) => a.name).join(', ') || 'none'}`);
  }
}

console.log('\n--- Fidelity notes (what got refused, and why) ---');
for (const n of notes) console.log(`  [${n.status}] ${n.component}: ${n.detail}`);

process.exit(0);
