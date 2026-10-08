/**
 * Pull all 5 requested agents (3 from local agentIRCache, 2 by live Dataverse extraction),
 * then for every connector operation they use, resolve it to a REAL API call (method + URL)
 * via the same captureOpIndex/bindOperation path the product uses at build time. Writes one
 * combined JSON to an out-of-repo path. Throwaway — not app code.
 */
import { connectDb, getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { resolveOpIndex } from '../connectors/captureOpIndex.js';
import { bindOperation } from '../connectors/operationBinding.js';
import type { AgentIR, TopicIR, KnowledgeSourceIR } from '../types.js';
import { writeFileSync } from 'node:fs';

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const ENVIRONMENT_ID = '7f9f87cc-464e-e470-95bb-363b7f227200';
const SCOPE = `ms-${TENANT_ID}`;

const OUT_PATH = process.argv[2] || './five_agents.json';

function trimTopic(t: TopicIR) {
  return {
    id: t.id, name: t.name, isSystem: t.isSystem,
    triggerPhrases: t.triggerPhrases, modelDescription: t.modelDescription,
    summary: (t.summary || '').slice(0, 300),
  };
}
function trimKS(k: KnowledgeSourceIR) {
  return { id: k.id, name: k.name, kind: k.kind, description: k.description, classification: k.classification };
}
function trimIR(ir: AgentIR) {
  return {
    name: ir.name,
    description: ir.description,
    instructions: ir.instructions,
    capabilities: ir.capabilities,
    unmapped: ir.unmapped,
    topics: (ir.topics || []).map(trimTopic),
    knowledgeSources: (ir.knowledgeSources || []).map(trimKS),
    agentTools: ir.agentTools ?? [],
    flows: (ir.flows || []).map((f) => ({
      id: f.id, name: f.name, ownerToolName: f.ownerToolName,
      actionCount: (f.actions || []).length,
      connectionReferences: f.connectionReferences,
    })),
  };
}

async function main() {
  await connectDb('csge');
  const db = getDb('csge');

  const cachedNames = ['Knowledge Assistant', 'Teams Coordinator', 'Email Manager'];
  const cached: AgentIR[] = [];
  for (const name of cachedNames) {
    const doc = await db.collection('agentIRCache').findOne({ 'ir.name': name });
    if (doc) cached.push(doc.ir as AgentIR);
  }

  const token = await clientCredsToken(TENANT_ID, ENV_URL);
  const bots = await listBots(ENV_URL, token);
  const liveNames = ['Credit Amendment workflow agent', 'Work Intelligence Network Agent'];
  const live: AgentIR[] = [];
  for (const name of liveNames) {
    const bot = bots.find((b) => b.name === name);
    if (!bot) { console.error('NOT FOUND:', name); continue; }
    const ir = await extractAgent(ENV_URL, token, bot);
    live.push(ir);
  }

  const allAgents = [...cached, ...live];

  // Unique (connectorId, operationId) pairs actually used, across all 5 agents.
  const pairs = new Map<string, { connectorId: string; operationId: string }>();
  for (const ir of allAgents) {
    for (const t of ir.agentTools ?? []) {
      if (t.kind === 'connector' && t.connectorId && t.operationId) {
        pairs.set(`${t.connectorId}::${t.operationId}`, { connectorId: t.connectorId, operationId: t.operationId });
      }
    }
  }

  const resolution: Record<string, unknown> = {};
  const connectorIndexCache = new Map<string, Awaited<ReturnType<typeof resolveOpIndex>>>();
  for (const { connectorId, operationId } of pairs.values()) {
    if (!connectorIndexCache.has(connectorId)) {
      const idx = await resolveOpIndex(connectorId, { tenantId: TENANT_ID, environmentId: ENVIRONMENT_ID, scope: SCOPE });
      connectorIndexCache.set(connectorId, idx);
    }
    const idx = connectorIndexCache.get(connectorId);
    const key = `${connectorId}::${operationId}`;
    if (!idx) {
      resolution[key] = { status: 'no-op-index-captured', connectorId, operationId };
      continue;
    }
    const bound = bindOperation(idx, operationId);
    resolution[key] = bound;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    agents: allAgents.map(trimIR),
    connectorApiResolution: resolution,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  // Summary to stdout so this doesn't require re-reading the JSON.
  console.log('\n=== SUMMARY ===');
  for (const ir of allAgents) {
    const tools = ir.agentTools ?? [];
    const connectors = [...new Set(tools.filter((t) => t.kind === 'connector').map((t) => t.connectorId))];
    console.log(`${ir.name}: ${tools.length} tools, connectors=[${connectors.join(', ')}]`);
  }
  console.log('\n=== RESOLUTION STATUS COUNTS ===');
  const counts: Record<string, number> = {};
  for (const v of Object.values(resolution)) {
    const status = (v as { status: string }).status;
    counts[status] = (counts[status] || 0) + 1;
  }
  console.log(counts);
  console.log('\n=== SAMPLE RESOLUTIONS (first 8) ===');
  console.log(JSON.stringify(Object.fromEntries([...Object.entries(resolution)].slice(0, 8)), null, 2));
  console.log(`\nWrote full JSON to: ${OUT_PATH}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
